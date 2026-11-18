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
| `FeatureDInd.tla`, `Ind.cfg` | the induction check of Grant preservation |
| `FeatureDGoals.tla`, `FeatureDFixtures.tla` | reachability traps, and the projection the replay fixtures are written from |
| `S1.cfg`-`S9.cfg` | the focused scenarios (`FeatureD.tla`, "Scenarios", says what each enables) |
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
| tla-ts: every check of `checks.json`, the fixtures, the comparison (about 20 s) | `pnpm exec vitest run -c vitest.node.config.ts --max-workers=2 test-node/feature-d-spec.test.ts` |
| official TLC: the same checks (about 90 s, one JVM at a time) | `mise exec -- node scripts/tlc-check.mjs` |
| one check's TLC trace, every variable at every step | `mise exec -- node scripts/tlc-check.mjs --only <name> --trace` |
| rewrite the replay fixtures after a spec change | `pnpm run spec:fixtures` |
| the replay against the real Store | `pnpm exec vitest run --max-workers=1 test/feature-d-replay.test.ts` |
| move the drift record forward (runs the spec check and the replay first) | `node scripts/feature-d-coverage.mjs forward` |

`tlc-check.mjs` downloads TLC's pinned jar into `node_modules/.cache/` once and checks its SHA-256; the JDK is the one
`mise.toml` pins (`mise install java`). CI runs it in `.github/workflows/spec.yml`. Before the replay exists,
`feature-d-coverage.mjs initial` records with the spec check alone.

The replay is a workerd test that runs each fixture (`test/fixtures/feature-d/<name>.json`) step by step against the
Store and compares `compareObservation` (`test/feature-d-observe.ts`) after each step. Each fixture's name appears as
a string literal in it; `feature-d-spec.test.ts` fails for a fixture the replay does not name.

## Reading a violation

A trace is a list of steps, each one indivisible in Kopje or Mastodon (`FeatureD.tla`'s header, ATOMICITY, cites the
code):

- `KRecv` with an envelope: one inbound activity in one Store transaction. `FR` a FeatureRequest, `Add`/`Rem` R's
  item Add or Remove, `Upd` an Update of C, `RemC` R's Remove of C, `DelR` R's actor Delete, `XAdd` another owner's Add
  naming L's authorization. `KApplyFetch` applies the instrument a FeatureRequest fetched.
- `KClaim`, `KFetch` (or `KFetch1`, `KFetch2` where pages move between GETs), `KApply`: a read of R's collections;
  `KLease` lets its lease run out and `KStale` is its late completion.
- `KRevoke`, `KBlock`, `KMemberGone`, `KCleanup`, `KExpire`: L's revoke, L's block, L's deletion, the retired row's
  cleanup, a retraction's expiry.
- `KDeliver`, `KDup`, `KGiveUp`, `KRetry`: one delivery of a recorded activity to R (processed by R in the same step,
  except in S7, where `RJob` is R's job), one whose response is lost, the last attempt given up, an operator's retry.
- `R*` and `XAdd` are R's requests and services; `Drop` loses an envelope; `Env` changes L's policy, the backlog, the
  retraction cap or how many of R's collections Kopje holds.

`last` in each state names the step, its input, what it recorded and its response; `k` is Kopje's core (`row`, its
`uri` listing, `obl` the obligation Grant preservation tracks), `rs` is R's server, `g` the history the invariants read.

Tell the two kinds of failure apart by the step that breaks the invariant:

- **A real bug** when every step is one Kopje and Mastodon can take, and the breaking step follows a rule of
  `FeatureDKopje.tla` as the design states it: the design (or the code, in a replay) is wrong at that rule.
- **A modelling error** when a step is one the real system cannot take (R sending what Mastodon never sends: check the
  cited file:line at v4.7.5), or a bound or merge in the abstraction makes it possible (`FeatureD.tla`, BOUNDS): fix the
  model, not the design.

A replay that disagrees at a step is a code bug unless the fixture's `unspecified` names the field (those are skipped)
or the step is one the Store cannot take as the fixture states it, which is a modelling question.

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

Not covered: other local members and owners, timing (a lease and a retraction's expiry are single events), the
owner-block and availability predicates of what others see, Misskey and other servers, and the code itself except
through the replay at the fixtures' steps.
