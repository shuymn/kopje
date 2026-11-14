# Engineering rules

How Kopje code and tests are written so that the invariants of the [threat model](threat-model.md) and the rules of
[visibility.md](visibility.md) keep holding: for imported data, under concurrency and at the bounds. The threat model
says what holds; this page says how a change keeps it. A cap that drops protocol-visible data is a departure from
Mastodon, decided as [mastodon-deviations.md](mastodon-deviations.md) says.

## Ordering, rounds and fences

- **Fences and ordering use transactional state**: counters, ids, generations, CHECKs and compare-and-set in the
  Store's transaction, never a timestamp the caller supplies.
- **Work split between a request and rounds never handles an item twice and always continues from durable state**
  (for example, notification removal records its fixed `max_id` boundary, and every batch, the request's first ones
  included, deletes what is still at or below it). A round that can run (its configuration is present and it is
  admitted) changes the state of at least one due item whenever one exists, so it cannot stall; a round that cannot
  run leaves its items as they are (push rounds without `VAPID_JWK`, RES-5). The total work of a bulk delete, its
  cascades included, is bounded.
- **Each family of rounds is its own error boundary** (`jobsRound` in `src/jobs/queue.ts`, RES-5): a Store family is
  one Store call, a Worker family one round of its own Store calls and fetches; a family's failure is logged and stops
  no other family, and only a Store refusal ends the round.
- **Each item of a round runs in its own savepoint, and a failure or a stall is recorded on the item** (the retry
  state of `src/domain/job-attempts.ts`, RES-5; inbound jobs: `runJobBatch` in `src/domain/inbox.ts`; every other
  family: `runJobItem`): a batch that throws or leaves work without moving its durable state (a progress write that
  changed a row, a cursor that advanced) counts an attempt; the item backs off and parks after its last, so it holds
  back no other item, and a progress write never rewrites unchanged state to look like progress. A family whose every
  batch moves a cursor, a phase or a row on, or ends its item, counts failures only. A family's selection takes a due
  retry first, and its pending answer comes from the same seeks, so a round with only parked or backing-off items asks
  for none. A request's first batch is such an item too: its failure leaves the request's own writes committed. A
  write that establishes a visibility or safety boundary (a hide, a mark, a block) is committed outside the item's
  savepoint, so a failed or parked item cannot undo it, and a new decision on an existing item resets its retry state
  with its generation, while a duplicate that changes nothing does not. A step without retry state (an unlock
  acceptance) isolates the part that can fail and keeps its cursor's advance outside it.
- **An operation may isolate a step in a savepoint** (`Db.savepoint`, `isolated` in `src/domain/job-attempts.ts`): a
  nested `transactionSync` inside the operation's transaction, so a step that throws rolls back alone and the operation
  goes on. The rollback does not reduce `total_changes()`, so a step's row budget is created inside the step. After an
  error SQLite cannot recover from, the operation fails at its commit and nothing commits; a Db without the capability
  (`op.run` outside the kernel without the storage's `transactionSync`) refuses the step.
- **A refusal that must avoid network work runs before any network-capable step** (a DNS check, a fetch, a Store call
  that may lead to one).
- **A credential or `now` that a Store call uses is taken after any await on network work**, never before it, and a
  writing path checks the Store's flags and the maintenance mode before any network-capable step.

## How a request talks to the Store

- **Store-local decisions whose inputs are available together are combined into one Store call.** A phase of a
  request ends at an external effect (verifying, fetching, sending) or at a commit, not at each read. A call stays
  separate only when its timing is the guarantee: a policy read after an awaited remote response (`fetchRefused` before
  a redirect hop or a later request, `webHopRefused`), a confirmation under lease right before a send
  (`confirmDelivery`), a one-time write (`ensureInstanceActorKey`).
- **A fetch's preparation (its signer and the policy verdict for its first request) is read in the answer that decides
  the fetch** (`FetchPreparation` in `src/domain/inbox.ts`, which names those answers), and a search resolution's
  actor revision read (`actorRevision`) carries the verdict for the actor's fetch the same way. It is optional: the
  Worker reads what is missing (`fetchSigner`, `fetchRefused`) as it would without it.
- **A federation GET is one read**, the setup check included (`src/domain/federation-reads.ts`; a route that does not
  read there reads the domain in the setup gate first, `src/federation/setup-gate.ts`).

## Bounds

- **Every bound names its unit**: JSON-escaped UTF-8 bytes, UTF-8 bytes, code points or UTF-16 code units. Its test
  measures in that unit, with NUL and astral characters among its inputs.
- **Bounds are checked where data crosses into the Worker and where it is returned**, after every expansion: JSON
  escaping, HTML sanitizing, hydration of nested entities, delete cascades. Tests assert the materialized rows or bytes,
  not the inputs.
- **Bounds hold for cutover-converted rows and legacy imports**, not only for what Kopje's writers produce; a growth
  test includes a converted-row fixture.
- **Measure a unit's maximum before setting an aggregate budget over it.**
- **Presented maxima are derived by a test** from the column caps at the worst JSON escaping; measured fills are
  witnesses at or below the derived figure. Each endpoint's maximum comes from its own bounds (RES-3, "Maxima of
  presented units", is the table they feed).
- **A memory bound that rests on an estimate has a runtime backstop** that counts bytes as they are read. Memory peaks
  are computed by a test from per-column maxima, never by arithmetic in prose; the test asserts each peak within its
  bound, and a figure the documents quote from its log is a measurement, labelled as one.

## Stored values

- **A new stored column or setting gets a stored bound that holds for imported values**, judged in order: the raw
  bytes first, then NUL anywhere, then the structure. Its writer drops what the trigger would refuse by sharing the
  trigger's acceptance rule, so a write never fails on it, and its presenter never throws on a stored value (RES-2,
  "stored values", applies this per column). The migration writes the trigger as `emitTriggers` gives it from that
  rule, registered in `src/domain/stored-triggers.ts`; `test/migrations.test.ts` holds every trigger of the migrated
  schema to its registered text, or to the list of those written by hand.
- **Every presented string or href passes its raw bound and its escaped-JSON bound after UTF-8 decoding**, through one
  shared helper per kind. A stored-bound predicate refuses NUL inside decoded JSON elements too, not only in the raw
  text.
- **A presented URL is judged twice**: on the decoded stored value before normalization, and on the normalized result
  after it. A value shown in its stored spelling refuses the characters that end or split an HTML attribute or a URL.
- **Imported TEXT may be malformed UTF-8 or non-canonical.** Compare, cut and identify stored values in SQL by bytes;
  never write a decoded string back as an identity; validate stored times with `isoTimeSql`
  (`src/platform/stored-bounds.ts`); pad a normalized id to its stored form before comparing (DATA-6).
- **A new write-time invariant means auditing every path that copies a stored value** (edits, snapshots, moves,
  conversions), and such copies are kept in SQL.
- **Before reading an existing column into the Worker, check its migration** for a CHECK or a trigger. A column bound
  only by its type affinity is projected in SQL before JavaScript sees it.

## Queries

- **A query bound is shown by `EXPLAIN QUERY PLAN` of the production SQL** at saturation with stale statistics
  (`ANALYZE` taken before the data grew), and a regression witness crosses the real cap. A query joining a large table
  pins its join order (`CROSS JOIN`, `INDEXED BY`) wherever stale statistics could choose a scan (RES-7). The Workers
  suites audit every statement the domain code runs in them (`test/sql-depth-setup.ts`, `test/plan-audit.ts`): planned
  under singleton statistics with up to three samples of the parameters the domain code passed, a plan that reads a
  whole table or index (a scan, an automatic index, a Bloom filter, a skip-scan) fails its suite unless
  `test/plan-audit-entries.ts` lists that scan of that statement. A reviewed fragment allowance
  (`test/plan-audit-allowances.ts`) stands for the entries of every statement that includes one shared fragment, with
  a witness that the fragment's read stays flat as its table grows; `sampleViolations` in `test/plan-audit.ts` decides
  when a scan is the fragment's. The attribution assumes the fragment is used as a predicate: a
  statement where the fragment's text is also a name (an implicit column name, a `NATURAL JOIN` or `USING` over it), or
  that forces the fragment's index with `INDEXED BY`, is outside what it proves. A listed scan a suite did not show is
  only reported, since another suite may pass the value that scans: a change that fixes listed
  statements removes their entries and shows the audit passes without them. The audit sees no prefix or range walk
  that EQP shows as a search, nor a plan only a value the suites never pass would choose (a partial index's
  condition); those keep a witness that grows under the same key. The domain SQL binds no LIKE or GLOB pattern.
- **A cap counts raw candidates before any residual predicate**: an inner stage reads the candidates by the walk's
  index and the predicate is applied outside it (paged reads: [visibility.md](visibility.md), "Read bounds"). Where
  passing the cap must be detected (a refusal or a cut past it), the inner stage reads cap + 1.
- **A work budget is one per request, shared by every retry, re-admission and fallback**, and charged with raw
  candidates before residual filtering, including the work of items and passes later rejected. A step starts only
  while the most it may read still fits, so the bound holds without measuring time (the Store's clock does not advance
  in synchronous code). A fallback that must always answer keeps a reserve for its own step (grouped notifications,
  RES-7).
- **A page may hold fewer rows than its limit only when its continuation is derived from the rows it consumed**, so no
  row is skipped (for example, an answer cut by its byte budget links on from the last row it consumed). A row is never
  dropped after the page's own `LIMIT`/`OFFSET` without the continuation moving past it.
- **A range on an optional cursor is a direct range** ([visibility.md](visibility.md), "Read bounds";
  `test-node/range-predicates.test.ts`).
- **workerd refuses `LIKE` and `GLOB` patterns over 50 bytes**; a pattern is kept within that.
- **SQLite 3.54.1 refuses a CTE reference resolved after too many cursors**: as many tables and subqueries numbered
  before it as the expression depth limit (100 in workerd) less 2, less 3 for a recursive CTE ("VIEWs and/or
  subqueries nested too deep"). SQLite numbers every FROM item of a SELECT, those of its FROM subqueries included,
  before it resolves any, then expands expression subqueries in text order (result columns, `WHERE`, `ORDER BY`) and
  compound arms right to left, so a CTE resolves after every FROM item of its SELECT and every expression subquery
  before it; and it expands a CTE's body once per reference, so each reference resolves the CTEs inside it again. Every
  statement the Workers suites run prepares at `CTE_GUARD_LIMIT` (96) on Node's 3.54.1 (`test-node/sql-depth.ts`), so
  a fragment holding a CTE (the coverage walks of `audience.ts`) keeps each reference within it: read rows in one pass
  rather than through a CTE referenced several times (`mergedWindow` in `windows.ts`), leave out a walk a sibling term
  of the same `AND` already implies, or resolve a walk ahead of the statement's other cursors without moving where it
  is evaluated (`statusReads`' `hoisted` in `audience.ts`, whose comment gives the mechanism). workerd from
  1.20261111.1 backs the rule out; the Node guard keeps enforcing it, and a statement that passes it prepares on
  either.

## Tests

- **A concurrency test holds one actor at an explicit await point while the other commits** (`Promise.all` alone is
  not a gate), runs the production paths, and crosses the real step boundaries (Store calls, rounds, network awaits).
- **A test that expects a refusal, an absence or `false` also shows that the guarded branch ran**, so it cannot pass
  because the input never reached the check.
- **A benchmark asserts that it ran the path it claims to time.**
- **What a page does once rendered is checked in the browser job** (`browser/`, `pnpm --filter kopje test:browser`,
  Chromium in CI): fixture pages from the real components under the production stylesheet and headers, with axe in both
  colour schemes. Layout, focus, disclosure state and CSP checks are cases there; markup contracts stay in parse5.
- **A workerd suite shares its worker with the suites run before it** (`vitest.config.ts`, without isolation): a test
  works on a Store of its own name, and what it leaves in module scope (a held call, a cache) is keyed per test or
  settles before the test ends, also when an assertion fails, unless it is the same for every test (the migrated schema
  `migratedStore` replays). The media bucket is emptied before each suite.

## Documents and comments

Each kind of fact has one home, and the other side points at it. A passage follows this when it is next touched.

- **A rule** lives in a document under its ID. A comment carries the ID and only what is local to that code.
- **A mechanism** lives in its module's header. A document points at the module and keeps what an operator or a
  reviewer needs without the code: limits, timings, accepted risks.
- **An inventory** lives in the code's data structure. Prose names the structure.
- **A number** is written as its constant's name, with the value only where a check ties the two.
- Two exceptions: the [threat model](threat-model.md) keeps complete invariant statements and their citations, and the
  operator documents keep values, because their readers do not have the code.
