# The lifecycle of a video or audio upload

A TLA+ specification of how a video or audio upload (#1828 PR4) moves between the upload route (v1 and v2), the
Store, the upload's processor Durable Object, its container, R2, the cron rounds, PITR restore, maintenance and the
owner, under lost replies, kills, late writes and clock offsets. It decides the ownership, precedence, processor steps,
replays and accepted windows that PR4's Store, processor and route implement. Paths are relative to `packages/kopje/`.

| File                    | Holds                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MediaUploadStore.tla`  | the Store's operations S1-S14, one operator per transaction, under the precedence K1, K3, K4 then each operation's own rule (K2 included)           |
| `MediaUpload.tla`       | the actors and their steps, the safety invariants and the liveness properties, each with the finding or design claim it stands for                  |
| `MediaUploadParams.tla` | the scenarios: the uploads, their endpoints and each fault's budget                                                                                 |
| `MediaUploadGoals.tla`  | reachability goals: each accepted window and each order the plan names is reached                                                                   |
| `<scenario>.cfg`        | one scenario each, with every safety invariant (or, `L1`-`L4`, every liveness property under `LSpec`)                                               |
| `checks.json`           | every check's expected outcome: each scenario's state count and depth, each mutation's broken property and trace length, each goal's witness length |

`MediaUpload.tla`'s `Mutations` declares each mutation as the property it breaks and the scenario it breaks it in;
`checks.json` must list exactly those.

## The checks

`scripts/media-upload-plan.mjs` turns `checks.json` into checks, and `test-node/media-upload-spec/` runs them under
tla-ts, in the `kopje-spec` project, which CI runs only for a change it reads:

```sh
pnpm exec vitest run -c vitest.spec.config.ts --max-workers=2 test-node/media-upload-spec/
```

A change of the specification that changes a count changes `checks.json` in the same commit, which says why. Every named
invariant and property has a mutation that the checker is seen to violate (`variants` in `checks.json`); the spec test
fails for a property without one.

## What the model abstracts

- Time is a small integer clock; the constants keep the design's order (`STAGING_MS` < `V2_PROCESS_MS` <=
  `TEARDOWN_MS`, the reservation's write deadline plus `STAGING_MS` within `AV_WRITE_WINDOW_MS`, `gc_at` after it).
  Most scenarios use the narrowest durations (`C0` in `MediaUploadParams.tla`); `H1W` widens `STAGING_MS` so that a
  delayed first S1 still leaves time to write and the Store's deadline falls after the route's cut, and `DLW` lengthens
  `V2_PROCESS_MS` so that a v2 deadline reaches `AV_WRITE_WINDOW_MS`. Only durations cross a clock boundary, so the
  route's and the processor's constant offsets (`skr`, `skd`) cancel; drift is not modelled.
- An R2 write may land at any time after it starts, or never. `LAND` stands for `ORPHAN_GRACE_MS`, how long after the
  write cut the tombstone keeps the authority to delete an upload's keys, as an image's tombstone does
  (`src/domain/media.ts`). Neither Cloudflare nor main bounds when a started put lands (the alarm's wall limit ends
  the writer, not the put), so a write that lands more than `LAND` after it started stays, as an image's does
  (`docs/threat-model.md`); the goal `DLW-LateLanding` reaches it and `NoLateObject` checks every earlier landing.
- One to three uploads. `MAX_AV_INFLIGHT` is 1 where two uploads compete, so the second meets a full instance, and 2
  in `CAP4` and `CAP5`, where a third arrives while two stops are retried; the capacity rules do not depend on the
  number.
- A cron round is one step per upload; the incomingOrphans pass's page is every key and one pass runs at a time, so
  its cursor, the checkpoint and overlapping claims decide nothing here (they bound which keys a round lists, not
  which it may delete); PR4-2's tests carry them.
- The encode, the container's input read and the still are one step with its outcome; the final writes are one to
  three (`originals/<id>`, `files/<token>/full`, `files/<token>/small`), each behind its own S5. The Images still and
  its charge are not modelled.
- Probes are one flag (the verdict S1 and S3 read) that an operator may revoke; their claim and cooldown are not here.
- The budget's allocation is not modelled: S3 charges one unit in the Store's own counter, and `ChargeOnce` reads it.
- S9 is read in the step that acts on it. It only sends the route to S10, which decides at its own commit, so a lost
  or late S9 reply is a poll not taken, or taken earlier, which the free order of `RoutePoll` and `RouteCut` covers.
- Budgets bound every fault, so no fault recurs for ever. The liveness scenarios take every step that can be taken now
  before the clock moves (`prompt`); `PendingStarts` needs that, since the cron's round, the run and the alarm's entry
  must fit in `ROOM - MINENC` (in production, `DISPATCH_MS` + the cron period + the processor's startup <
  `deadline_at` - now - `T_MIN_ENCODE`); without it the job may wait past its deadline. Some safety scenarios are
  prompt for the route or the cron, to bound their size.
- A live processor takes its due alarm, and its replay's stop or slot renewal, before the clock moves while its
  container runs, except for `lag` units a scenario allows (`CAP5`: one, with one killed invocation). `STOP_HOLD`
  (`STOP_HOLD_MS`) outlasts both; Cloudflare documents no bound on an alarm's delay, so an alarm later than
  `STOP_HOLD_MS`, like a processor that stops for good (the fault `gone`), is W10. A renewal that maintenance refuses
  is W10 too once the slot lapses (`MTS`).
- The number of invocations is bounded only by the clock: an alarm fires at most once a time unit, so no bound of the
  model cuts a retry sequence short (Codex r2 CM8; `L5` retries seven stops).
- A restore and a maintenance window may be held back to `rsAt` and `mAt`, so that `RSS`, `MTS` and `MTR` begin them
  on an upload already under way rather than at time 0.

## What the specification will describe

`coverage.json`, the drift record of the code the specification describes, starts with PR4-1. It will list:

- `migrations/0121_media_processing.sql`, `src/domain/media-processing.ts` (S1-S14, K1-K4, `allocate`),
  `src/store.ts` and `src/store-rpc.ts` (the RPCs and the restore marker they read), `src/domain/media.ts`
  (the reservation's write deadline, the sweep, the tombstone's retirement), `src/platform/media-files.ts`
  (`mediaKeys`, `incomingKey`);
- `src/media-processor.ts` (`run`, the alarm's D1-D9 and the cleanup replay), `src/jobs/media-jobs.ts` (`runUpload`,
  `mediaDispatchRound`, `incomingOrphans`);
- `src/mastodon/media.ts` and `src/mastodon/media-av.ts` (the route's staging, queue, v1 wait and cleanup authority).
