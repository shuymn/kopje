# The lifecycle of a video or audio upload

A TLA+ specification of how a video or audio upload (#1828 PR4) moves between the upload route (v1 and v2), the
Store, the upload's processor Durable Object, its container, R2, the cron rounds, PITR restore, maintenance and the
owner, under lost replies, kills, late writes and clock offsets. It decides the ownership, precedence, processor steps,
replays and accepted windows that PR4's Store, processor and route implement. Paths are relative to `packages/kopje/`.

| File                    | Holds                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MediaUploadStore.tla`  | the Store's operations S1-S13, one operator per transaction, under the precedence K1, K3, K4 then each operation's own rule (K2 included)           |
| `MediaUpload.tla`       | the actors and their steps, the safety invariants and the liveness properties, each with the finding or design claim it stands for                  |
| `MediaUploadParams.tla` | the scenarios: the uploads, their endpoints and each fault's budget                                                                                 |
| `MediaUploadGoals.tla`  | reachability goals: each accepted window and each order the plan names is reached                                                                   |
| `<scenario>.cfg`        | one scenario each, with every safety invariant (or, `L1`-`L4`, every liveness property under `LSpec`)                                               |
| `checks.json`           | every check's expected outcome: each scenario's state count and depth, each mutation's broken property and trace length, each goal's witness length |

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
  Only durations cross a clock boundary, so a constant offset (`skd`) cancels; drift is not modelled.
- One or two uploads. `MAX_AV_INFLIGHT` is 1 where two uploads compete, so the second meets a full instance; the
  capacity rules do not depend on the number.
- A cron round is one step per upload; the incomingOrphans pass's page is every key, so its cursor and the checkpoint's
  fence decide nothing here (they bound which keys a round lists, not which it may delete).
- The encode, the container's input read and the still are one step with its outcome; the final writes are one or two
  (`files/<token>/full`, and `originals/<id>` before it), each behind its own S5. The Images still and its charge are
  not modelled.
- Probes are one flag (the verdict S1 and S3 read) that an operator may revoke; their claim and cooldown are not here.
- Budgets bound every fault, so no fault recurs for ever; the liveness scenarios take every step that can be taken now
  before the clock moves (`prompt`), and the two-upload scenarios do so for the route and the cron, to bound their size.

## What the specification will describe

`coverage.json`, the drift record of the code the specification describes, starts with PR4-1. It will list:

- `migrations/0121_media_processing.sql`, `src/domain/media-processing.ts` (S1-S13, K1-K4, `allocate`),
  `src/store.ts` and `src/store-rpc.ts` (the RPCs and the restore marker they read), `src/domain/media.ts`
  (the reservation's write deadline, the sweep, the tombstone's retirement), `src/platform/media-files.ts`
  (`mediaKeys`, `incomingKey`);
- `src/media-processor.ts` (`run`, the alarm's D1-D9 and the cleanup replay), `src/jobs/media-jobs.ts` (`runUpload`,
  `mediaDispatchRound`, `incomingOrphans`);
- `src/mastodon/media.ts` and `src/mastodon/media-av.ts` (the route's staging, queue, v1 wait and cleanup authority).
