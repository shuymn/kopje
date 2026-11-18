--------------------------- MODULE FeatureDFixtures ---------------------------
(***************************************************************************)
(* The replay fixtures' projection: with ALIAS Alias, each step of a       *)
(* goal's shortest trace is the action, its input, the environment Kopje   *)
(* decides in and the observation the real Store must give after it, as    *)
(* JSON. test/feature-d-observe.ts types it, and                           *)
(* test-node/feature-d-fixtures.ts writes the fixtures.                    *)
(***************************************************************************)
EXTENDS FeatureDGoals, Json

Environment ==
  [consent |-> env.consent, slotsFull |-> env.slots, held |-> env.held, backlogFull |-> env.bl,
   retractionCapFull |-> env.cap]

Alias == [json |-> ToJson([action |-> last.act, input |-> last.arg, environment |-> Environment,
                           observation |-> Observation])]
=============================================================================
