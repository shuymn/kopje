---
name: verify-feature-d
description: Kopje's TLA+ oracle for a local member of a remote owner's featured collection (#1589, design (d), packages/kopje/spec/feature-d/). Use when a change touches a file listed in spec/feature-d/coverage.json or the spec itself, when a feature-d test fails, or when a replay of a feature-d fixture disagrees with the Store.
---

# Verifying feature authorizations (design (d))

`packages/kopje/spec/feature-d/` specifies how Kopje keeps a local member L's membership in a remote owner R's
collection C, with R on Mastodon v4.7.5: when L accepts, hides or deletes, and what R ends up holding. It is the
oracle the implementation is held to. Commands below run from `packages/kopje/`.

| File | Holds |
|---|---|
| `FeatureDKopje.tla` | Kopje's rules (K1-K14), one operator per Store transaction, written from design (d) |
| `FeatureD.tla` | the protocol: Kopje's steps, R's (cited to Mastodon file:line), the network; the invariants and goals |
| `FeatureDInd.tla`, `Ind.cfg` | the induction check of Grant preservation, from every state of the core's type |
| `FeatureDGoals.tla`, `FeatureDFixtures.tla` | reachability traps, and the projection the replay fixtures are written from |
| `S1.cfg`-`S15.cfg` | the focused scenarios (`FeatureD.tla`, "Scenarios", says what each enables) |
| `checks.json` | every check's expected outcome, which both checkers must give |
| `coverage.json` | the Kopje files and functions the spec describes, with their blobs when last confirmed |

## Does the change touch the verified code?

The coverage test fails, naming the file, once a file in `coverage.json` differs from its recorded blob:

```sh
pnpm exec vitest run -c vitest.node.config.ts --max-workers=2 test-node/feature-d-coverage.test.ts
```

A failure is a re-look: run the checks below, change the spec through a challenge if the behaviour changed, then move
the record forward. A change to `spec/feature-d/` itself always needs the checks.

## The checks

| Check | Command |
|---|---|
| tla-ts: every check of `checks.json`, the fixtures, the comparison (about 2 min, the inductions 1 min of it) | `pnpm exec vitest run -c vitest.spec.config.ts --max-workers=2` |
| official TLC: the same checks (about 2 min, one JVM at a time) | `MISE_ENV=spec mise exec -- node scripts/tlc-check.mjs` |
| one check's TLC trace, every variable at every step | `MISE_ENV=spec mise exec -- node scripts/tlc-check.mjs --only <name> --trace` |
| rewrite the replay fixtures after a spec change | `pnpm run spec:fixtures` |
| the replay against the real Store | `pnpm exec vitest run --max-workers=1 test/feature-d-replay.test.ts` |
| move the drift record forward (runs the spec check and the replay first) | `node scripts/feature-d-coverage.mjs forward` |

`tlc-check.mjs` downloads TLC's pinned jar into `node_modules/.cache/` once and checks its SHA-256. The JDK is the one
`mise.spec.toml` pins, apart from `mise.toml` so that only these checks install it: `MISE_ENV=spec mise install java`.
CI runs it in `.github/workflows/spec.yml` with `MISE_ENV=spec`, and runs the tla-ts checks as the `kopje-spec`
project only for a change they read (`scripts/test-affected.sh`, `kopje_spec`). Before the replay exists,
`feature-d-coverage.mjs initial` records with the spec check alone.

The replay is a workerd test with one test per fixture (`test/fixtures/feature-d/<name>.json`), titled by the
fixture's name, that runs its steps against the Store and compares `compareObservation` (`test/feature-d-observe.ts`)
after each one. `feature-d-spec.test.ts` fails for a fixture the replay does not name, and for a skipped test;
`feature-d-coverage.mjs forward` fails unless every fixture's test ran and passed. No fixture takes `KMemberGone`
(Kopje deletes no local account), and the spec test checks that.

## Reading a violation

A trace is a list of steps, each one indivisible in Kopje or Mastodon (`FeatureD.tla`'s header, ATOMICITY, cites the
code):

- `KRecv` with an envelope: one inbound activity in one Store transaction. `FR` a FeatureRequest, `Add`/`Rem` R's
  item Add or Remove, `Upd` an Update of C, `RemC` R's Remove of C, `DelR` R's actor Delete, `XAdd` another owner's Add
  naming L's authorization. A FeatureRequest for a collection Kopje does not store answers "fetch" (response 1 in the
  spec) and takes the instrument; `KApplyFetch` is the resumed activity, with the final status.
- `KClaim`, `KFetch` (or `KFetch1`, `KFetch2` where pages move between GETs), `KApply`: a read of R's collections.
  `KLease` lets its lease run out, which alone fences nothing; a `KClaim` after it writes a new token, and the old
  round's late completion is `KStale`. A claim whose input is `sameTime` is made in the millisecond of the row's last
  change, which the row fence counts as changed. `readRequested` is R's sync row, kept from the request (or the
  claim) until a completion reads it through.
- `KRecv` of `DelR` has the input `purged` (the first purge batch, in the same transaction, reaches C: R has little
  else to purge) or `deferred` (the replay seeds R with other content first, so a later `KPurge` batch reaches C).
- `KRevoke`, `KBlock`, `KSuspend`, `KUnsuspend`, `KCleanup`, `KEvict`, `KPurge`, `KExpire`: L's revoke and block, L's
  suspension and its end, the retired row's cleanup or early eviction (input `insertAt50`: the replay fills C to 50
  rows with L's retired row the oldest and inserts another member's row, which evicts it in the same transaction), one
  later batch of R's purge that reaches C, a retraction's expiry. `KMemberGone`, L's deletion, is model-only.
- `KDeliver`, `KDup`, `KGiveUp`, `KRetry`: the POST of the head of Kopje's lane to R's server, the same POST with its
  response lost (the head stays), the head given up, an operator's retry (admitted again, then behind the head).
  `RJob` is one of R's jobs, which run in any order.
- `R*` and `XAdd` are R's requests and services; `Drop` loses an envelope; `Env` changes L's policy, the backlog, the
  retraction cap, C's slots or how many of R's collections Kopje holds.

`last` in each state names the step, its input, what it recorded and its response; `k` is Kopje's core (`row`, its
`uri` listing), `rs` is R's server, `g` the history the invariants read (`obl` the obligation Grant preservation
tracks, `unexcused` the corrections CR3 counts, `lastRd` the latest read that covered the row, which OV2
compares). `MemberAvailability` fails when Kopje answers for, creates or lists L's row while L is unavailable.

Tell the two kinds of failure apart by the step that breaks the invariant:

- **A real bug** when every step is one Kopje and Mastodon can take, and the breaking step follows a rule of
  `FeatureDKopje.tla` as the design states it: the design (or the code, in a replay) is wrong at that rule.
- **A modelling error** when a step is one the real system cannot take (R sending what Mastodon never sends: check the
  cited file:line at v4.7.5), or a bound or merge in the abstraction makes it possible (`FeatureD.tla`, BOUNDS): fix the
  model, not the design.

A replay that disagrees at a step is a code bug unless the fixture's `unspecified` names the field (those are skipped),
the extra activity is one its `mayAlsoRecord` permits, or the step is one the Store cannot take as the fixture states
it, which is a modelling question.

If tla-ts and TLC disagree, that is a finding about a checker: report it with both outputs and keep the spec as it is.

## Changing the spec

The spec, its checks, the fixtures and the comparison are what the implementation is held to, so a change to them
comes first and on its own, as a written challenge: the input or trace, the design's verdict, the expected verdict,
and evidence (Mastodon's source at v4.7.5, or a counter-example). Once it is accepted: edit the spec, rerun both
checkers, update `checks.json` with the reason for each changed count in the commit, rewrite the fixtures, and move the
drift record forward. A new rule that can fail gets a calibration variant (`Variant`, marked `VARIANT` in the spec)
whose named invariant must fail.

## Bounds and what is not covered

One owner R (plus X on R's server in S4), one member L, one collection C (other collections only as C's place on R's
pages and as Kopje's count of R's collections), two requests and two authorizations, and per-scenario budgets
(`FeatureD.tla`, Bud). There is no fairness, so nothing is checked about eventually: any message may wait for ever.

Not covered: other local members and owners (the 25 slots and the 50 stored rows are environment flags), timing (a
lease and a retraction's expiry are single events), a purge batch that reaches part of C, the owner-block predicate of what others see, Misskey and other
servers, the Store's SQL work bounds (its own tests), and the code itself except through the replay at the fixtures'
steps.
