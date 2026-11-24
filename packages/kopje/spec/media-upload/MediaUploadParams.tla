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
(*  late    uploads whose request arrives no earlier than lateAt, and      *)
(*  later   of those, the ones that arrive no earlier than laterAt         *)
(*  c       the durations (MediaUploadStore.tla, TIME): C0 for most; CW,    *)
(*          where a delayed S1 still leaves STAGING_MS to write, so the     *)
(*          Store's deadline falls after the route's cut (Codex r1 CM1);    *)
(*          CD, where a v2 deadline reaches AV_WRITE_WINDOW_MS (D5); CT,    *)
(*          where a stop retried past the job's deadline fits the           *)
(*          scenario's time and HARD_HOLD_MS lies beyond it, so a slot      *)
(*          counts there by its grant alone (W10 is not reached)            *)
(*  nw      the final writes of a job, each behind its own S5 (1: full;     *)
(*          2: originals/<id> then full; 3: then small)                     *)
(*  loss    lost replies, and RPCs that fail before their commit, on any    *)
(*          route or processor call; loseRun lets a `run` be lost           *)
(*  kill    processor invocations killed at any step                        *)
(*  dfail   container stops that fail (destroy not confirmed)               *)
(*  gone    processors that stop for good with their container running     *)
(*          (no alarm or request runs again; W10 once HARD_HOLD_MS has      *)
(*          passed since the grant)                                         *)
(*  lag     clock units a processor's due step may wait (Cloudflare bounds *)
(*          an alarm's delay nowhere)                                       *)
(*  stale   stop confirmations (S8) carrying a teardown_id that is not the  *)
(*          slot's                                                          *)
(*  perr    R2 writes that answer an error (and may still land)             *)
(*  rdie    route requests that die                                         *)
(*  del     owner DELETEs                                                   *)
(*  mOn     maintenance windows, none beginning before mAt                  *)
(*  bm, rs  bookmarks taken and PITR restores, each to any bookmark taken,  *)
(*          no restore before rsAt                                          *)
(*  rev     revocations of the normalize probe's verdict (M5)               *)
(*  bad     a body or text field the route refuses                          *)
(*  fails   an encode the input fails (cause refused)                       *)
(*  orphan  the incomingOrphans pass runs                                   *)
(*  kept    the owner attaches an upload whose id it was answered, so the   *)
(*          sweep never takes it once completed (an attached upload has no  *)
(*          gc_at)                                                          *)
(*  gc      the sweep, reconciliation and the tombstone's retirement run    *)
(*  skd     the processor's clock offset from the Store's                   *)
(*  skr     the route's clock offset from the Store's                       *)
(*  prompt  the kinds of actor ("route", "do", "cron") whose steps that can *)
(*          be taken now are taken before the clock moves: all of them in  *)
(*          the liveness scenarios (MediaUpload.tla, LIVENESS), some in    *)
(*          the two-upload ones to bound their size; the others may wait   *)
(*  tmax    the last time of the behaviour                                  *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS Scenario, Variant

All == {"route", "do", "cron"}

\* STAGING_MS, V1_TIME_MS, V2_PROCESS_MS, TEARDOWN_MS, AV_WRITE_WINDOW_MS and HARD_HOLD_MS in abstract units.
\* HARD_HOLD_MS is V2_PROCESS_MS + TEARDOWN_MS at least, so that only a stop failing past every deadline reaches it
\* (in production 24 hours against minutes).
C0 == [staging |-> 1, v1 |-> 3, v2p |-> 2, teardown |-> 3, ww |-> 4, hh |-> 5]
CW == [C0 EXCEPT !.staging = 2, !.ww = 5]
CD == [C0 EXCEPT !.v2p = 3, !.hh = 6]
CT == [C0 EXCEPT !.teardown = 2, !.hh = 10]

Base ==
  [up |-> {"u1"}, v1 |-> {}, max |-> 2, arr |-> 0, late |-> {}, lateAt |-> 0, later |-> {}, laterAt |-> 0, c |-> C0, nw |-> 1, loss |-> 0, loseRun |-> FALSE, kill |-> 0,
   dfail |-> 0, gone |-> 0, lag |-> 0, stale |-> 0, perr |-> 0, rdie |-> 0, del |-> 0, mOn |-> 0, mAt |-> 0, bm |-> 0,
   rs |-> 0, rsAt |-> 0, rev |-> 0, bad |-> FALSE,
   fails |-> FALSE, orphan |-> FALSE, kept |-> FALSE, gc |-> TRUE, skd |-> 0, skr |-> 0, prompt |-> {}, tmax |-> 6]

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
   \* v2, a lost reply and a kill in one behaviour (Gemini r1 GH4).
   LK |-> [Base EXCEPT !.loss = 1, !.kill = 1, !.tmax = 7],
   \* v2, three writes, each granted on its own, with the deadline at AV_WRITE_WINDOW_MS and DELETE (D5).
   DLW |-> [Base EXCEPT !.c = CD, !.nw = 3, !.del = 1, !.tmax = 7],
   \* v2, two writes, DELETE, a failed write and a route that dies.
   V2D |-> [Base EXCEPT !.nw = 2, !.del = 1, !.perr = 1, !.rdie = 1, !.tmax = 7],
   \* Maintenance across a v1 upload, with a kill.
   MT |-> [Base EXCEPT !.v1 = {"u1"}, !.kill = 1, !.mOn = 1],
   \* Maintenance across a v2 upload with two writes.
   MT2 |-> [Base EXCEPT !.nw = 2, !.mOn = 1, !.tmax = 7],
   \* Maintenance across a v2 upload with DELETE and a stop that is not confirmed (Gemini r1 GH4).
   MTX |-> [Base EXCEPT !.mOn = 1, !.del = 1, !.dfail = 1, !.tmax = 7],
   \* Maintenance from t = 1 across a v2 upload whose stop is retried, with a restore and the incomingOrphans pass
   \* (Gemini r1 GH4, r2 GM4).
   MTR |-> [Base EXCEPT !.mOn = 1, !.mAt = 1, !.dfail = 2, !.bm = 1, !.rs = 1, !.orphan = TRUE, !.prompt = All],
   \* Maintenance from t = 1 across a stop that is retried, and an upload that arrives after it: maintenance refuses
   \* the stop confirmation and the slot counts on (D8, D16).
   MTS |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.c = CT, !.arr = 9, !.late = {"u2"}, !.lateAt = 5, !.mOn = 1,
                        !.mAt = 1, !.dfail = 7, !.gc = FALSE, !.prompt = All, !.tmax = 9],
   \* A restore from t = 3 across a stop that is retried, and an upload that arrives after it (Codex r3 CH2: the
   \* restore no longer shortens what a slot counts, D16, D18).
   RSS |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.c = CT, !.arr = 7, !.late = {"u2"}, !.lateAt = 4, !.bm = 1,
                        !.rs = 1, !.rsAt = 3, !.dfail = 4, !.gc = FALSE, !.prompt = All, !.tmax = 7],
   \* Three v2 uploads, one slot, stops that are not confirmed, and two restores to one bookmark, the second and third
   \* uploads arriving after the first and the second restore (Codex r3 CH2: W3's bound per restore, D18).
   RSD |-> [Base EXCEPT !.up = {"u1", "u2", "u3"}, !.max = 1, !.c = CT, !.arr = 3, !.late = {"u2", "u3"}, !.lateAt = 2,
                        !.later = {"u3"}, !.laterAt = 3, !.bm = 1, !.rs = 2, !.rsAt = 1, !.dfail = 6, !.gc = FALSE,
                        !.prompt = All, !.tmax = 3],
   \* v1 on the wider clock CW, across maintenance: the route's cut before the Store's deadline (Codex r1 CM1).
   H1W |-> [Base EXCEPT !.v1 = {"u1"}, !.c = CW, !.mOn = 1, !.tmax = 7],
   \* A PITR restore across a v1 upload.
   RS |-> [Base EXCEPT !.v1 = {"u1"}, !.bm = 1, !.rs = 1, !.prompt = {"cron"}],
   \* A PITR restore across a v2 upload whose processor runs on, with a kill.
   RS2 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.kill = 1, !.gc = FALSE],
   \* A PITR restore across a v2 upload, with a lost reply (Gemini r1 GH4).
   RSL |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.loss = 1, !.gc = FALSE, !.prompt = {"cron"}],
   \* A PITR restore across a v2 upload, with DELETE.
   RS3 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.del = 1, !.gc = FALSE, !.prompt = {"cron"}],
   \* Two v2 uploads competing for one slot, with DELETE.
   CAP |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.del = 1, !.gc = FALSE,
                        !.prompt = {"cron", "route"}, !.tmax = 5],
   \* Two v2 uploads competing for one slot across a restore.
   CAP2 |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.bm = 1, !.rs = 1, !.gc = FALSE,
                         !.prompt = {"cron", "route"}, !.tmax = 5],
   \* Two v2 uploads, one slot: the first's stop is retried across a restore, and the second arrives after it (Codex r2
   \* CH2: W3 over the cap).
   CAP6 |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 1, !.late = {"u2"}, !.lateAt = 1, !.bm = 1, !.rs = 1,
                         !.dfail = 2, !.gc = FALSE, !.prompt = All, !.tmax = 5],
   \* Two v2 uploads, one slot: the first's stop is not confirmed and its processor stops for good, and the second
   \* arrives once HARD_HOLD_MS has passed since the first's grant (W10, D17).
   CAP3 |-> [Base EXCEPT !.up = {"u1", "u2"}, !.max = 1, !.arr = 5, !.late = {"u2"}, !.lateAt = 5, !.dfail = 1,
                         !.gone = 1, !.gc = FALSE, !.prompt = {"cron", "route"}, !.tmax = 5],
   \* Three v2 uploads, two slots, stops that are not confirmed, arrivals while they are retried (Codex r1 CH3), alarms
   \* up to three units late (Codex r3 CH1) and a stop confirmation of another teardown (Gemini r2 GM3, Codex r2 CM3).
   CAP4 |-> [Base EXCEPT !.up = {"u1", "u2", "u3"}, !.c = CT, !.arr = 5, !.late = {"u3"}, !.lateAt = 4, !.dfail = 8,
                         !.lag = 3, !.stale = 1, !.gc = FALSE, !.prompt = All, !.tmax = 7],
   \* CAP4 with a killed invocation and an alarm one unit late (Gemini r2 GH1, Codex r2 CH1).
   CAP5 |-> [Base EXCEPT !.up = {"u1", "u2", "u3"}, !.c = CT, !.arr = 5, !.late = {"u3"}, !.lateAt = 4, !.dfail = 8,
                         !.kill = 1, !.lag = 1, !.gc = FALSE, !.prompt = All, !.tmax = 7],
   \* The incomingOrphans pass across two restores, with a route that dies.
   OR |-> [Base EXCEPT !.orphan = TRUE, !.bm = 2, !.rs = 2, !.rdie = 1, !.prompt = All],
   \* The processor's clock one unit behind the Store's and the route's one ahead, two writes, DELETE.
   SK |-> [Base EXCEPT !.nw = 2, !.skd = -1, !.skr = 1, !.del = 1, !.tmax = 7],
   \* Liveness: a v2 upload with a lost reply, a kill, a stop that is not confirmed and a failed write.
   L1 |-> [Base EXCEPT !.loss = 1, !.kill = 1, !.dfail = 1, !.perr = 1, !.prompt = All, !.tmax = 10],
   \* Liveness: L1 with seven stops that are not confirmed in a row (Codex r2 CM8).
   L5 |-> [Base EXCEPT !.loss = 1, !.kill = 1, !.dfail = 7, !.perr = 1, !.prompt = All, !.tmax = 10],
   \* Liveness: a v2 upload whose run is lost (W7).
   L4 |-> [Base EXCEPT !.loss = 1, !.loseRun = TRUE, !.prompt = All, !.tmax = 10],
   \* Liveness: a v1 upload across maintenance with a lost reply and a refused body.
   L2 |-> [Base EXCEPT !.v1 = {"u1"}, !.mOn = 1, !.loss = 1, !.bad = TRUE, !.kept = TRUE, !.prompt = All, !.tmax = 10],
   \* Liveness: a v2 upload across a restore, its processor killed once, with the incomingOrphans pass.
   L3 |-> [Base EXCEPT !.bm = 1, !.rs = 1, !.kill = 1, !.orphan = TRUE, !.prompt = All, !.tmax = 10]]

P == Params[Scenario]
U == P.up
MaxInflight == P.max
Writes == 1..P.nw

=============================================================================
