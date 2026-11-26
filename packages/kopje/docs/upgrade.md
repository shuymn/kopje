# Upgrading and rolling back a Kopje instance

An instance is a small repository made from the [instance template](../../../deploy/README.md): a `package.json` that
pins one `kopje` version, and a `wrangler.jsonc` that is the same for every install. Upgrading means deploying another
`kopje` version. The instance's data is in the Store (one SQLite-backed Durable Object), and the Store upgrades its own
schema the first time the new code runs.

Kopje follows [semver](https://semver.org). Each version has release notes in
[CHANGELOG.md](../CHANGELOG.md) and on the GitHub release. They say when a version changes the Store's schema, and when
the template's `wrangler.jsonc` must change (a new binding, a new compatibility date or flag). Before 1.0, a minor
version may break things; read the notes of every version you skip.

The instance's `wrangler.jsonc` is its own file: a version that changes the template's does not change it. Make the
same change on the pull request that updates `kopje`, before you merge it (step 3 below). In particular,
`compatibility_flags` must hold `global_fetch_strictly_public` as well as `nodejs_compat`, so that every outbound fetch
uses public routing, a host in the instance's own zone included (NET-1 in the
[threat model](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/threat-model.md)).
`kopje-admin health` fails its `runtime` check while the running Worker lacks it. The template also sets
`"workers_dev": false`: Kopje answers only on the instance domain (WEB-6), so the Worker's `workers.dev` address only
redirects or refuses; with it off, the next deploy removes that address. Attach the instance domain before you turn it
off on an instance that has none yet.

The template sets `"limits": { "cpu_ms": 60000 }` as well: a request, a Queue batch and a Store invocation may each use
up to 60 seconds of CPU, where the platform's default is 30. The Store applies and verifies a version's migrations in
one invocation (below), and they can need more than 30 seconds; a release's are held to 40 seconds on a large benchmark
Store ([RELEASING.md](../RELEASING.md)). Without the line, such an upgrade is stopped part way, and until a later
attempt finishes the Store refuses every request, reads and sign-ins included, while migrations remain unapplied
(`schema-pending`), and stays readonly once they are applied but not yet verified. Each attempt resumes after the
migrations already recorded and checks foreign keys over the whole Store, which on a large Store is most of an upgrade's
time, so the attempts can keep failing. Add the line and deploy; the upgrade then resumes. Setting the limit costs
nothing by itself; the CPU time used is billed as before.

## How an update arrives

1. Dependabot (with the template's `.github/dependabot.yml`) opens a pull request that changes the `kopje` version in
   `package.json`, and never merges it by itself. The pull request carries the version's release notes, which start
   with a reminder to read them and this page before merging.
2. Read the release notes. Check `kopje-admin health` (below): an instance that is already in maintenance, or has a
   backup dump in progress, upgrades later than you expect.
3. Merge the pull request. Workers Builds (or the GitHub Actions workflow) installs the new version and runs
   `wrangler deploy`. There is no separate migration step.

Without Dependabot (or the Renovate app, with an earlier template's `renovate.json`), change the version in
`package.json` yourself, run `npm install` to update the lockfile, and push.

## What happens on deploy

Every deployment gets a new Workers version id. The Worker passes it on every call to the Store, and the Store compares
it with its own (both are the same script, so after the deploy both run the new code).

- **While the deploy rolls out**, some requests can still reach the old code. A Store that sees a different version id
  refuses the call as `version-mismatch`: the Mastodon API and the web answer 503 for that moment, and activities that
  other servers deliver to the inbox are spooled and replayed later, so none is lost.
- **On the first call to the new code**, the Store checks its schema against the migrations the new version ships. If
  some are not applied, it schedules the upgrade at once. Until its migrations are applied, the Store refuses every
  request, reads and sign-ins included (`schema-pending`): the Mastodon API and the web answer 503, the inbox spools,
  and the actor documents, WebFinger and NodeInfo answer from the last snapshot.
- **The upgrade** runs inside the Store, in three phases:
  1. it records the Store's current point-in-time-recovery bookmark (`lastBookmark` in `kopje-admin health`), before
     it changes anything;
  2. it applies each pending migration in its own transaction and records it by name and checksum;
  3. it verifies the result, and only then leaves readonly: the recorded migrations, and `PRAGMA foreign_key_check`
     over the whole Store. The whole-Store foreign-key scan is skipped only when the upgrade finds no earlier
     attempt marker and every pending migration is declared to preserve references and referenced keys. Resumed
     upgrades, retries, verification-only runs and upgrades without that guarantee scan the whole Store; on a large
     Store this dominates upgrade time.

  The second and third phases run in one invocation of the Store: a request that arrives meanwhile waits for them to
  end, and never meets a partly applied schema. An upgrade that is interrupted resumes from where it stopped. An
  upgrade waits for a backup dump or an import that is running, and starts when it ends.

- **If a phase fails**, the Store holds (`bookmark-failed`, `upgrade-failed` or `verify-failed`) and logs the reason
  (`kopje.store.upgrade.failed`; [observability.md](observability.md) says where to find it). A held Store refuses
  every request while `schema.status` in `kopje-admin health` is not `current` (usually because a migration remains
  unapplied), and is readonly once it is: reads and sign-ins work, and writes answer 503. The hold stays until the
  next deployment, or until you run
  `kopje-admin upgrade retry`. Nothing is lost while it holds: the inbox keeps spooling. Fix the cause (or roll back,
  below), then retry or deploy.
- **If the Store's schema has migrations the code does not know** (`schema-diverged`), for example after a rollback
  across a schema change, the Store refuses every request until the code and the schema match again.

[What the Store serves in each state](#what-the-store-serves-in-each-state), below, says what the Store answers for
each state `kopje-admin health` can report.

Check the result with the admin CLI. [setup.md](setup.md#running-the-admin-cli) says how to run it: in the instance's
repository, `kopje-admin <command>` below is `npm run admin -- <command>`.

```sh
export KOPJE_ADMIN_URL=https://example.com CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...
kopje-admin version   # the Worker's build, the Store's build, and the newest expected and applied migration
kopje-admin health    # versionMatch, schema, readonly, hold, upgrading, lastBookmark
```

After a successful upgrade, `versionMatch` is true, `schema.status` is `current`, `readonly` is false, and
`lastBookmark` is the bookmark taken before the upgrade. **Write it down** before you do anything else: it is what a
rollback across this upgrade restores, and the next upgrade replaces it.

Some migrations rewrite stored values and keep no copy, such as `0048_stored_bounds` and `0049_instance_bounds`; the
release notes ([CHANGELOG.md](../CHANGELOG.md)) say which values each rewrites. A restore to this bookmark is how to
recover such a value.

### What the Store serves in each state

What the instance answers follows from three values that `kopje-admin health` reports: `schema.status`, `hold` and
`upgrading`. Every combination of them matches exactly one row: "any" matches every value, and "a reason" every hold.

| `schema.status` | `hold`   | `upgrading` | Reads  | Sign-in | Writes | Refused as            | Inbox     | Actor, WebFinger, NodeInfo | `readonly` |
| --------------- | -------- | ----------- | ------ | ------- | ------ | --------------------- | --------- | -------------------------- | ---------- |
| `pending`       | any      | any         | 503    | 503     | 503    | `schema-pending`      | spooled   | snapshot                   | `true`     |
| `diverged`      | any      | any         | 503    | 503     | 503    | `schema-diverged`     | spooled   | snapshot                   | `true`     |
| `current`       | a reason | any         | served | served  | 503    | the `hold`            | spooled   | served                     | `true`     |
| `current`       | `null`   | `true`      | served | served  | 503    | `upgrade-in-progress` | spooled   | served                     | `true`     |
| `current`       | `null`   | `false`     | served | served  | served | —                     | processed | served                     | `false`    |

- **503** is the answer of the Mastodon API and the web pages. Writes include deleting media, and the media rebuild
  is refused wherever writes are.
- **Refused as** is the `reason` that `kopje.store.unavailable` logs ([observability.md](observability.md)).
- **Spooled**: the inbox keeps the activity and replays it once the Store processes again, so none is lost.
- **Snapshot**: actor documents, WebFinger and NodeInfo answer from the last good answer saved for the same request,
  and 503 where none was saved.
- **`readonly: true`** means that the Store refuses writes. While `schema.status` is not `current`, it refuses reads
  and sign-ins too.
- While the Store applies and verifies, which it does in one invocation, a request waits for it to end,
  `kopje-admin health` included, and is then answered by the row of the state the Store ends in.

The table is the Store's own state. Maintenance the operator turns on (`MAINTENANCE`), a backup dump and an import
refuse more on top of it ([backup.md](backup.md)).

#### How a Store reaches each state

Examples, not a complete list: the table above says what the Store serves in whatever state it reports.

| How the Store gets there                                                        | `schema.status` | `hold`            | `upgrading` |
| ------------------------------------------------------------------------------- | --------------- | ----------------- | ----------- |
| Migrations pending, none applied yet                                            | `pending`       | `null`            | `false`     |
| Stopped while applying, until the next attempt                                  | `pending`       | `null`            | `true`      |
| Stopped before verifying, until the next attempt                                | `current`       | `null`            | `true`      |
| Held: `bookmark-failed`, before the upgrade is recorded                         | `pending`       | `bookmark-failed` | `false`     |
| Held: `bookmark-failed`, once the upgrade is recorded                           | `pending`       | `bookmark-failed` | `true`      |
| Held: `bookmark-failed` by an attempt that overlapped one that finished         | `current`       | `bookmark-failed` | `false`     |
| Held: `bookmark-failed` by an attempt that overlapped one that failed to verify | `current`       | `bookmark-failed` | `true`      |
| Held: `upgrade-failed`, a migration unapplied                                   | `pending`       | `upgrade-failed`  | `true`      |
| Held: `upgrade-failed`, every migration applied                                 | `current`       | `upgrade-failed`  | `true`      |
| Held: `upgrade-failed`, its state not read back, in the isolate that failed     | `pending`       | `upgrade-failed`  | `false`     |
| Held: `verify-failed`, before verification is recorded                          | `current`       | `verify-failed`   | `true`      |
| Held: `verify-failed`, once verification is recorded                            | `current`       | `verify-failed`   | `false`     |
| Schema diverged                                                                 | `diverged`      | `null`            | `false`     |
| Schema diverged, an upgrade left unfinished                                     | `diverged`      | `null`            | `true`      |
| Upgraded                                                                        | `current`       | `null`            | `false`     |

The upgrade records itself, with its bookmark, before it applies the first migration, and removes the record in the
transaction that verifies the result; `upgrading` is `true` while the record is kept. A storage error can be reported
after the transaction it ends has committed (a timeout), so a hold comes with or without the record. Two attempts can
overlap (the alarm and `kopje-admin upgrade retry`), and a hold the later one records lands on the schema the earlier
one left. A rollback of the code across an upgrade that did not finish leaves the record, and `upgrading` stays
`true` until the code and the schema match again. If the state cannot be read back after a hold is recorded, the
isolate that failed takes every migration as pending until it ends; a new isolate reports the stored state.

## Rolling back

A rollback has two parts: the code (a Workers rollback) and, if the version changed the schema, the data (a
point-in-time restore of the Store to the bookmark taken before the upgrade).

### A version that did not change the schema

The release notes say so, and `kopje-admin version` shows the same newest migration before and after. Roll back the
code only:

- in the dashboard: Workers & Pages, your Worker, Deployments, then Rollback on the previous version; or
- `npx wrangler deployments list` and `npx wrangler rollback <version-id>`.

The Store runs the older code from then on, and its schema still matches. Then pin the older `kopje` version in
`package.json` (and close or postpone the update pull request), or the next build deploys the newer one again.

Rows the newer code wrote keep their meaning where the older code reads them. One case sends more than the newer code
would: a release without the signed `Delete` of a public or unlisted status (VIS-3 in
[threat-model.md](threat-model.md)) ignores the envelope's `addressing` and places that `Delete`'s copies by its own
`to`, Public alone, so a mentioned account still staging gets a copy of its own at its personal inbox rather than its
server's shared one. The body goes unchanged to each (it is immutable, which those releases honor), names nobody, and
reaches no inbox the audience does not hold: more POSTs, never a wider reach.

A page a browser loaded from one version and submits to the other is read by the other's rules. Since the release that
reads a repeated parameter's last value, as Rails does (#1729), the settings page writes each checkbox's hidden
`false` before the box; a settings page loaded before that upgrade, or loaded after it and saved after a rollback across
it, saves its ticked boxes as unticked. Reload any open settings page after an upgrade or a rollback across that
release.

### A version that changed the schema

The older code cannot use the newer schema, so the data must go back too. The restore returns the Store to the moment
before the upgrade: **everything written after it is lost**. That includes posts, follows and settings changed since,
and activities other servers delivered and the instance accepted. Roll back this way only soon after an upgrade that
went wrong. If the upgrade succeeded and the new version only has a bug, prefer a fixed version.

You need the bookmark recorded before the upgrade (`lastBookmark`). Durable Objects keep point-in-time recovery for 30
days, so the bookmark must be younger than that.

1. **Roll back the code**, as above. The Store now reports `schema-diverged` and refuses every request.
2. **Set `MAINTENANCE=full`** on the Worker (dashboard: Settings, Variables and Secrets; as a plain-text variable).
   Set it after the rollback: a rollback restores the variables the old version had. The restore is refused without
   it, because it rewinds every flag inside the Store; the variable holds the instance from outside meanwhile.
3. **Restore the Store** to the bookmark:

   ```sh
   kopje-admin pitr restore <lastBookmark> --yes
   ```

   The Store restarts to apply it. The call answers `restoring`. A restore is refused while `media-rebuild` runs;
   after it, a media rebuild waits 20 minutes of maintenance again, and the remote media cache waits 20 minutes before
   it checks its files again ([backup.md](backup.md)). Once the instance serves again (step 5), run
   `kopje-admin media-rebuild` ([backup.md](backup.md), "Restore"): a restore can bring back a video or audio upload
   whose files a sweep deleted after the bookmark, which the rebuild reports as `original-missing`.

4. **Check** with `kopje-admin health`: `schema.status` is `current`, and `versionMatch` is true.
5. **Remove `MAINTENANCE`** (or set it to `off`). The instance serves again; spooled inbox activities are replayed.
6. **Pin the older version** in `package.json`, as above.

To look up a bookmark for another time (within the 30 days), use `kopje-admin pitr bookmark --at <ISO 8601 time>`.
A bookmark from after the upgrade has the newer schema, and the older code cannot use it.

### If the admin CLI cannot reach the instance

`kopje-admin` goes through the `/admin` Access application. If Access is not usable, recreate the application (see
[setup.md](setup.md), "After setup"). The daily backup ([backup.md](backup.md)) is the last resort; restoring from it
loses everything since that backup.
