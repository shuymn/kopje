# The media processor

The media processor is the optional container that turns video and audio into the files Kopje serves (#1828). It is
added by the deploy template's "Video and audio" block ([deploy/README.md](../../../deploy/README.md)). This page is
for the operator: how it is activated, what its probes and health report, and how to turn it off. The mechanisms live
in `src/media-processor.ts` (the Durable Object), `src/jobs/media-jobs.ts` (an upload's work and the rounds) and
`src/mastodon/media-activation.ts` (the activation probe); the rules are in the [threat model](threat-model.md)
(MEDIA-2, MEDIA-8, RES-1).

In this release no route accepts a video or audio upload yet: an upload of either still answers 422. What runs is the
processor's side, so that it can be checked on an instance before uploads are turned on.

## Activation

Uploads of video and audio are active when all three hold, for the Worker version that is deployed:

- the `MEDIA_PROCESSOR` binding (the template's block);
- `MEDIA_UPLOAD_MONTHLY_JOBS` above 0, the container jobs uploads may start in a UTC month;
- a passed activation probe of `normalize@standard-4` for that version.

A budget without the binding is not a configuration error: it activates nothing, and health says so. A new version
starts without a verdict, so it is image-only until its probe passes. The media rebuild's stills are activated
separately, by their own probe of `still@standard-1`.

## The activation probe

The cron (every 5 minutes) runs the probe of `normalize@standard-4` when the binding and a positive budget are present
and the profile needs one: no verdict for the deployed version, an upload's infrastructure failure since the last pass,
or a pass whose Images step could not be checked, an hour after it. One claim a profile is shared with
`kopje-admin media-processor probe normalize@standard-4`, so the two never probe at once, and a claim is not given again
within an hour of the last one for the same version.

The probe copies the 2-second clip that ships in the package to `incoming/probe-<nonce>` in the media bucket, starts the
container on standard-4 without Internet access, streams the copy through it, holds the output to Kopje's verifier with
the duration the container declared, checks the still, stops the container, has Images re-encode the still, and deletes
the copy. A copy left by a Worker that died is removed by the orphan pass below. Its outcome:

| Outcome      | When                                                                                                                                                                                                        | Effect                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pass`       | every check passed and Images re-encoded the still (`imagesVerified: true`), or every earlier check passed and Images answered that the month's allowance is used up (9422; `imagesVerified: false`)        | uploads are admitted; an unverified pass is probed again after an hour |
| `fail`       | the build answered wrongly in a way it always will: its readiness check answered 404, a reply broke the `/normalize` contract, the clip was refused, or its output, still or Images' input check refused it | uploads are refused until a later probe passes                         |
| `no-verdict` | the container never became ready, the processor was busy or unavailable, a stage timed out, or Images failed another way                                                                                    | the last verdict stands; health shows `lastProbe: "unavailable"`       |

An upload whose still Images refuses as input, though the verifier passed it, completes with the default poster and
records an infrastructure failure, which has the next cron probe again; it revokes nothing. A container answer that is
a processing outcome of the input (a 500 such as `encode_failed`) is the upload's own failure, never the processor's.

`kopje-admin media-processor probe` runs the same probe on request. It writes the Store, so it is refused while the
instance is in maintenance or its Store is read-only, and the CLI prints that refusal.

## Health

The detailed health report (`/admin/health`) has a `mediaProcessor` check, read from the Store without starting a
container:

| State         | Meaning                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`    | no binding, or `MEDIA_UPLOAD_MONTHLY_JOBS` is 0 (`reason`)                                                                                          |
| `provisioned` | the binding and a budget, and no verdict for this version: `lastProbe` is `unavailable` when a probe reached none, `never` before the first         |
| `ready`       | a pass for this version; `imagesVerified: false` notes a pass whose Images step answered 9422, `infrastructureFailure` an upload's failure since it |
| `degraded`    | the probe failed for this version; uploads are refused                                                                                              |

Each state carries the month's spent jobs (`spent`), the budget and the capacity slots that count now (`slots`).

## Uploads, capacity and cleanup

At most two uploads are processed at once (`MAX_AV_INFLIGHT`). An upload's container runs in its own Durable Object,
which keeps a cleanup alarm before it starts anything: a job interrupted at any point is cleaned up by that alarm, and
its capacity slot counts until the container's stop is confirmed, or for at most 24 hours after the job started
(`HARD_HOLD_MS`). A container whose stop never succeeds is retried every minute; past those 24 hours Kopje admits
another upload beside it, and Cloudflare bills that container until it stops. An upload's object drops its own record
at most `V2_PROCESS_MS` + `HARD_HOLD_MS` after it was dispatched, with its container stopped.

The cron also redispatches an upload whose start was lost (after 2 minutes), fails jobs past their deadline, and once an
hour removes inputs under `incoming/` that are more than a day old and held by no upload, probe copies included.

The Containers dashboard lists every destroyed container as "Failed": that is how a container Kopje stops is shown, and
is normal. Each image Kopje builds is about 300 MB in the account's container registry; delete the images of versions
no deployed Worker uses (`npx wrangler containers images list`). A colour profile the encoder cannot use is dropped and
the video is encoded under the BT.709 label (design #1828, A5).

## Restoring the Store

Before a point-in-time restore of the Store, set `MEDIA_UPLOAD_MONTHLY_JOBS` to 0 and wait until health shows no slot
in use. After it, a restored slot can make uploads answer busy until its job's deadline, or for up to 24 hours if its
job had started, until the processor confirms its stop ([backup.md](backup.md), "Media recovery guarantee").

## Turning it off

Set `MEDIA_UPLOAD_MONTHLY_JOBS` to 0: uploads of video and audio are refused, the probe round stops, and jobs already
queued finish. To remove the processor, follow [deploy/README.md](../../../deploy/README.md), "Video and audio".
