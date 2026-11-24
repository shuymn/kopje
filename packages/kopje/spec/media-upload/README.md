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
| `<scenario>.cfg`        | one scenario each, with every safety invariant (or, `L1`-`L5`, every liveness property under `LSpec`)                                               |
| `checks.json`           | every check's expected outcome: each scenario's state count and depth, each mutation's broken property and trace length, each goal's witness length |

`MediaUpload.tla`'s `Mutations` declares each mutation as the property it breaks and the scenario it breaks it in;
`checks.json` must list exactly those (`test-node/media-upload-spec-plan.test.ts`, in the Node suite, which every Kopje
change runs).

## The checks

`scripts/media-upload-plan.mjs` turns `checks.json` into checks, and `test-node/media-upload-spec/` runs them under
tla-ts, in the `kopje-spec` project, which CI runs only for a change it reads:

```sh
pnpm exec vitest run -c vitest.spec.config.ts --max-workers=2 test-node/media-upload-spec/
```

A change of the specification that changes a count changes `checks.json` in the same commit, which says why. Every named
invariant and property has a mutation that the checker is seen to violate (`variants` in `checks.json`); the plan test
fails for a property without one. `test-node/media-upload-spec-parts.test.ts` checks that the `kopje-spec` project
collects every part's file and that each lies in a CI shard of its own.

Each safety property and each exception it allows compares the step it checks against ghost state recorded at the
event that grounds it (the reservation, the grant, the queue's deadline, the Store's cleanup answer, S10's decision and
commit, the answer sent, each restore's bookmark and what it rewrote, the purge, the start of maintenance), never
against a value that step computes, so a mutation of the step cannot also move its check. Two checks hold for every
step without each action raising them: `MaintInert` compares the Store with its state when maintenance began, and
`RestoreExact` compares the Store after a restore with the bookmark it chose.

## What the model abstracts

- Time is a small integer clock; the constants keep the design's order (`STAGING_MS` < `V2_PROCESS_MS` <=
  `TEARDOWN_MS`, the reservation's write deadline plus `STAGING_MS` within `AV_WRITE_WINDOW_MS`, `gc_at` after it).
  Most scenarios use the narrowest durations (`C0` in `MediaUploadParams.tla`); `H1W` widens `STAGING_MS` so that a
  delayed first S1 still leaves time to write and the Store's deadline falls after the route's cut, and lengthens
  `T_MIN_ENCODE` so that S4 can fail a job S3 queued (the early timeout, v1 500), and `DLW` lengthens `V2_PROCESS_MS`
  past `AV_WRITE_WINDOW_MS`, so that the write window caps a v2 deadline. Only durations cross a clock boundary, so the
  route's and the processor's constant offsets (`skr`, `skd`) cancel; drift is not modelled.
- An R2 write may land at any time after it starts, or never. `LAND` stands for `ORPHAN_GRACE_MS`. Main's rule for an
  image (`src/domain/media.ts`, `purgeMedia`, `dueOrphans`) keeps the authority to delete an unfinished upload's keys
  until a successful reconciliation after the tombstone's `delete_after`, max(purge, write deadline) +
  `ORPHAN_GRACE_MS`. The model's tombstone keeps that `delete_after` and is retired, with a last deletion, once it is
  due. `NoLateObject` computes the end of that authority itself, from the purge's time and the reservation's, and
  also holds the retirement to `ORPHAN_GRACE_MS` after each write's start; it checks that nothing lands, and no write
  is in flight, between the retirement and then, and that the retirement leaves no key behind (mutations
  `EarlyRetire`, `RetireIgnoresPurge`, `DeleteAfterNoPurge`, `DeleteAfterNoLand`, `QueueNoCap`, `RetireNoDelete`, all
  in `DLW`). Only `DLW` keeps a purge's time past the write deadline (it adds a state per purge time); the other
  scenarios count every purge as before it, in the Store and in the check alike, so they check the authority of an
  early purge only, not a stricter rule. Neither Cloudflare nor main bounds when a started put lands (the alarm's wall
  limit ends the writer, not the put), so the lasting residual is a key that lands after that last deletion, between
  it and the tombstone's removal included (main deletes the keys, then the tombstone; the model takes the two as one,
  since the deletion commutes with the Store's steps), or one a restore forgot (no row, no tombstone): it stays, as an
  image's does (`docs/threat-model.md`). The goal `DLW-LateLanding` reaches the first, `RS2-Forgotten` the second.
- The sweep is main's two steps, the deletion of the upload's keys and then `purgeMedia`, which deletes the row only
  if it is still sweepable, in the scenarios with `split` (`V1L`, `RSW`, `RS12`), where a late S10 or a restore
  may come between them; elsewhere one step. Between the two, a completed row whose files are gone is past its
  `gc_at`, so S10 answers 503 for it, as main reads such a row as gone (mutation `S10IgnoresGc`).
- One to three uploads. `MAX_AV_INFLIGHT` is 1 where two or three uploads compete, so a later one meets a full
  instance, and 2 in `CAP4` and `CAP5`, where a third arrives while two stops are retried; the capacity rules do not
  depend on the number.
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
- Capacity is counted by confirmation (D16): a slot whose start was granted counts until the processor's stop
  confirmation (S8) deletes it, or `HARD_HOLD` (`HARD_HOLD_MS`) after the grant's stored time, so no alarm delay, kill
  or operator gate frees it earlier. Cloudflare documents no bound on an alarm's delay; scenarios that make the
  processor a prompt actor let the cleanup of a container that still runs (its due alarm, the replay's start call or
  its stop) wait `lag` units (`CAP4`: three, `CAP5`: one with a killed invocation). `HARD_HOLD` lies past the time of
  the scenarios that check this (`CT`), and within it where W10 is reached (`CAP3`: a processor gone for good, and a
  second upload admitted beside its container).
- W3, the other exception, is derived from the Store's state: the latest restore's bookmark holds no grant of an
  upload granted before it, and the Store holds none since. A later restore to a bookmark that holds the grant ends it
  (`RSB`: two restores, each to either of two bookmarks). It counts one container for each forgotten grant, whether
  the container ran at the restore or starts after it, and such a start still meets the job's deadline.
- A restore's time (`ra`, `restoredAt`) fences reservations; replies are ordered against restores by the restores'
  sequence number (`rn`), so two restores in one time unit (`RST`) are two.
- The number of invocations is bounded only by the clock: an alarm fires at most once a time unit, so no bound of the
  model cuts a retry sequence short (Codex r2 CM8; `L5` retries seven stops).
- A restore and a maintenance window may be held back to `rsAt` and `mAt`, so that `RSS`, `MTS` and `MTR` begin them
  on an upload already under way rather than at time 0.

## What the specification will describe

`coverage.json`, the drift record of the code the specification describes, starts with PR4-1. It will list:

- `migrations/0121_media_processing.sql`, `src/domain/media-processing.ts` (S1-S13, K1-K4, `allocate`),
  `src/store.ts` and `src/store-rpc.ts` (the RPCs and the restore marker they read), `src/domain/media.ts`
  (the reservation's write deadline, the sweep, the tombstone's retirement), `src/platform/media-files.ts`
  (`mediaKeys`, `incomingKey`);
- `src/media-processor.ts` (`run`, the alarm's D1-D9 and the cleanup replay), `src/jobs/media-jobs.ts` (`runUpload`,
  `mediaDispatchRound`, `incomingOrphans`);
- `src/mastodon/media.ts` and `src/mastodon/media-av.ts` (the route's staging, queue, v1 wait and cleanup authority).
