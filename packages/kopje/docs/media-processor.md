# The media processor

The media processor is the optional container that turns video and audio into the files Kopje serves, and that makes
still frames of cached remote videos. It is added by the deploy template's "Video and audio" block
([deploy/README.md](../../../deploy/README.md)). This page is for the operator: how it is activated, what an upload and
a remote still cost and answer, what its probes and health report, and how to turn it off. The rules are in the
[threat model](threat-model.md) (MEDIA-2, MEDIA-4, MEDIA-6, MEDIA-7, MEDIA-8, MEDIA-9, RES-1, RES-6).

## Activation

Uploads of video and audio are active when all three hold, for the Worker version that is deployed; the instance
then advertises video and audio types on `/api/v1/instance` and `/api/v2/instance`, and `/api/v{1,2}/media` takes
them. Otherwise an upload of either answers 422 as an unsupported type, and the instance advertises images only.

- the `MEDIA_PROCESSOR` binding (the template's block);
- `MEDIA_UPLOAD_MONTHLY_JOBS` above 0, the container jobs uploads may start in a UTC month;
- a passed activation probe of `normalize@standard-4` for that version.

A budget without the binding is not a configuration error: it activates nothing, and health says so. A new version
starts without a verdict, so it is image-only until its probe passes.

Remote stills ([below](#remote-stills)) are active, apart from uploads, when the binding is there,
`MEDIA_STILL_MONTHLY_JOBS` is above 0 and the activation probe of `still@standard-1` passed for the deployed version.
The media rebuild's stills use the same probe.

## The activation probe

The cron (every 5 minutes) runs the probe of each profile whose own budget is positive, with the binding, when the
profile needs one: `normalize@standard-4` for `MEDIA_UPLOAD_MONTHLY_JOBS`, `still@standard-1` for
`MEDIA_STILL_MONTHLY_JOBS`. A profile needs one with no verdict for the deployed version, an infrastructure failure
since the last pass (an upload's, or a remote still's), or a pass whose Images step could not be checked, an hour after
it. The cron, `kopje-admin media-processor probe` and, for `still@standard-1`, the media rebuild share one claim per
profile, so no two probe at once. A claim for the same version is not given again within an hour (`PROBE_RETRY_MS`) of
one that recorded an outcome, or within 5 minutes (`PROBE_CLAIM_MS`) of one that recorded none.

The probe of `normalize@standard-4` copies the 2-second clip that ships in the package to `incoming/probe-<nonce>` in
the media bucket, runs it through a container on standard-4 without Internet access, holds the output to Kopje's
verifier, checks the still, stops the container, has Images re-encode the still, and deletes the copy. Images sees the
still only once the stop is confirmed, so a probe given up at its deadline cannot stop a later probe's container.

The probe is sent only with at least `PROBE_FLOOR_MS` (6,568 ms) left once the copy is read: twice the clip's envelope
(2,284 ms, the least encode time the server's plan admits the clip in, pinned by `plan_test.go`) and its way in (the
body and ffprobe, 1 s). Its outcome:

| Outcome      | When                                                                                                                                                                                                                                                                                                                                                                                                            | Effect                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pass`       | every check passed and Images re-encoded the still (`imagesVerified: true`), or every earlier check passed and Images answered that the month's allowance is used up (9422; `imagesVerified: false`)                                                                                                                                                                                                            | uploads are admitted; an unverified pass is probed again after an hour |
| `fail`       | only on positive evidence that the build is wrong: `/healthz` answered 404 or 405, or without this protocol's version; a route of the protocol answered 404 (bare or `not_found`) or 405; a 200 broke the reply's contract (its headers, kind or length); the verifier refused the output or found its declared duration wrong; `verifyStill` refused the still; or Images refused that verified still as input | uploads are refused until a later probe passes                         |
| `no-verdict` | anything else: any code the container answers (`envelope`, `encode_failed`, `internal`, `truncated`, `no_output`, `bad_request`, a refusal of the clip, a 500 naming `not_found`), a video without its still, busy, a gateway's reply, a lost connection or short body, less than the floor left to send it, a stage that timed out, Images' output failing the still's checks, or Images failing another way   | the last verdict stands; health shows `lastProbe: "unavailable"`       |

An upload whose still Images refuses as input, though the verifier passed it, completes with the default poster and
records an infrastructure failure, which has the next cron probe again; it revokes nothing. A container answer that is
a processing outcome of the input (a 500 such as `encode_failed`) is the upload's own failure, never the processor's.

The probe of `still@standard-1` makes a still of the same clip's copy on standard-1, holds its PNG to `verifyStill` and
has Images re-encode it, with the same outcomes; it fails on the same kind of evidence: `/healthz` or `/still` answering
404 or 405, `verifyStill` refusing the PNG, or Images refusing it as input.

`kopje-admin media-processor probe` runs the same probes on request (one profile, or every profile by default) and
records each verdict for the deployed version under the profile's claim, as the cron does, even while that profile's
budget is 0. A profile whose probe was claimed within its cooldown is not run again: it prints `cooldown` and the CLI
exits 1, as it does for any profile whose verdict is not a recorded pass. The still probe takes a `/healthz` without the
version as ready, since `/still` is unchanged since the image before it, so a Worker that activates before its image
keeps the media rebuild's still. Both start a container and write a probe copy to the media bucket, so they are refused
while the instance is in maintenance or its Store is read-only.

The request has one deadline, `PROBE_ROUTE_MS` (290 s, 10 s under the 300 s the CLI waits for the response's headers),
from its arrival. Each step ends at the earlier of that deadline and its own bound, and no step starts past it. A
credential check or body past its cut answers 504; a claim or record past its cut answers `unconfirmed`. A probe the
probe object refuses before it starts a container (busy) answers `not_started` and records nothing. A pass whose claim
is older than an infrastructure failure recorded for its build records nothing (`stale`): the failure is the newer
evidence. A record already sent may still commit in the Store after its reply is lost, under its claim's fence.

The probe's work and the copy's delete outlive a client that disconnects by at most the Worker's grace (30 s); a copy
left after that is the orphan pass's. The container's stop does not depend on the request: the probe object attempts it
by its own deadline (240 s from its start for normalize, 75 s for the still probe), and its alarm retries a destroy that
has not answered until the container is gone.

## Health

The detailed health report (`/admin/health`) has a `mediaProcessor` check, read from the Store without starting a
container, over the profiles the positive budgets need: `normalize@standard-4` when `MEDIA_UPLOAD_MONTHLY_JOBS` is above
0, `still@standard-1` when `MEDIA_STILL_MONTHLY_JOBS` is. Each needed profile is in one of the last three states below,
and the check's state is the worst of them (`degraded`, then `provisioned`, then `ready`), with each profile's own under
`profiles`:

| State         | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`    | no budget above 0 (`reason: "budget"`), or a budget above 0 without the binding (`reason: "binding"`, for either budget)                        |
| `provisioned` | no verdict for this version: `lastProbe` is `unavailable` when a probe reached none, `never` before the first                                   |
| `ready`       | a pass for this version; `imagesVerified: false` notes a pass whose Images step answered 9422, `infrastructureFailure` a job's failure since it |
| `degraded`    | the probe failed for this version; its kind (uploads, or remote stills) is refused                                                              |

A budget without the binding is `disabled`, not `degraded`: nothing was ever admitted, so nothing is refused. Each state
carries the uploads' month's spent jobs (`spent`), their budget and the capacity slots that count now (`slots`), and
`stills` with the remote stills' spent jobs and budget. Only `degraded` fails the check.

With both profiles needed, the top level carries each profile's qualifiers only as the worst state allows: `lastProbe`
only when the check is `provisioned` (`unavailable` when either provisioned profile's is, else `never`),
`imagesVerified` only when it is `ready` (false when either profile's is), and `infrastructureFailure: true` whenever
a profile that is `ready` has one, whatever the check's state. `profiles` holds each profile's own.

## Uploads

An upload's file is staged into R2 while the request is read (at most 90 MiB, `AV_UPLOAD_LIMIT`), then queued, which
charges one job of `MEDIA_UPLOAD_MONTHLY_JOBS`; a refused or abandoned upload charges nothing. `/api/v2/media` answers
202 at once and the client polls `GET /api/v1/media/:id`. `/api/v1/media` answers within `V1_TIME_MS` of the request's
arrival, its reservation and reading included: it takes its decision `T_REPLY` (2 s, the decision's round trip with
room) before that time, and answers 503 `Media processing took too long. Try a shorter file.` once it passes. That
decision cancels an upload still processing. An upload decided just before the 503, or whose decision's reply was
lost, keeps its outcome: a completed one stays unattached until the sweep deletes unattached media a day later.

Cleanup after a refused or abandoned upload (aborting the staging, deleting its input, abandoning the reservation) may
finish after the answer, within the 30 s the Worker lives after it; what it leaves, the sweep, the `incoming/` orphan
pass or the bucket's lifecycle rule for incomplete multipart uploads removes. The route has no disconnect trigger: a
client that disconnects starts that cleanup only when the staging ends on its own or its time ends, and a queue call
already sent may still accept, charge and process the upload. When the processor turns inactive after the reservation
(its probe failed), a v1 request goes on as an image: after the 503 it may still deduct three units from the account's
and the instance's Images allowances, and an image completing then is unattached and swept the same way.

`V1_TIME_MS` is a constant of the release, not a setting: 480 s (8 minutes, `V2_PROCESS_MS`). Elk's v1 upload in
desktop Chrome, Firefox and WebKit held an answer 600 s and more, so the shortest measured wait less 10 % is past
`V2_PROCESS_MS`, which caps it. Safari on iOS and the mobile apps were not measured; a client that stops waiting sooner
shows the upload as failed while it completes, unattached, and is swept.

Estimated admission limits. The container refuses a video (422 `Validation failed: File is too long or too large to
process`) whose conservative encode estimate passes 0.7 of the encode time its endpoint leaves. The table gives what
that estimate admits with this release's constants, from the estimate model (`container/server/plan.go`) and the time
allocation (`allocate` in `src/domain/media-processing.ts`) for a 90 MiB input, each stage taking its planned time, and
on v1 3 s from the request's arrival to the queue. These are estimates, not measured wall times: measured encodes took
0.38 to 1.08 of their estimate. Every file is also at most 90 MiB, which at b Mb/s is about 755 / b seconds, and at
most 600 s of video or 1200 s of audio.

| Source                                 | `/api/v1/media`                                | `/api/v2/media`            |
| -------------------------------------- | ---------------------------------------------- | -------------------------- |
| H.264 or HEVC, 1080p up to 30 fps, SDR | 600 s                                          | 600 s                      |
| H.264, 1080p60, SDR                    | up to 111 s, and 120–600 s (encoded at 720p30) | up to 113 s, and 120–600 s |
| HEVC, 2160p30, SDR                     | 463 s                                          | 468 s                      |
| HEVC, 2160p30, HDR (tone mapped)       | 69 s                                           | 70 s                       |
| HEVC, 2160p60, HDR (tone mapped)       | 35 s                                           | 35 s                       |
| Audio (MP3 output)                     | 1200 s                                         | 1200 s                     |

A video is re-encoded to an H.264 and AAC MP4 (at most 1080p at 60 fps up to 120 s, 720p at 30 fps up to 300 s, 480p
at 30 fps up to 600 s), audio to MP3; a longer file, or one past the processing envelope, is refused with 422. A colour
profile the encoder cannot use is dropped and the video is encoded under the BT.709 label. Two uploads at once already
processing make a third answer 503 `Media processing is busy. Try again in a moment.`

Cost. An upload runs one `standard-4` container (4 vCPU, 12 GiB of memory, 20 GB of disk) for its wall time W, at most
`V2_PROCESS_MS` (8 minutes) plus its stop: about 12 × W GiB-s of memory, 20 × W GB-s of disk and up to 4 × W vCPU-s
of CPU, billed against the Workers Paid allowance (90,000 GiB-s, 720,000 GB-s and 22,500 vCPU-s a month, shared with
any other container) and at Cloudflare's container prices beyond it. A one-minute 1080p video takes well under two
minutes; the worst job, 8 minutes, is 5,760 GiB-s, so `MEDIA_UPLOAD_MONTHLY_JOBS` × 5,760 GiB-s bounds the month's
memory. Set the budget from that bound and the allowance left for other containers. One account can spend the whole
month's budget ([threat model](threat-model.md), "Accepted risks").

Thumbnails. A video or audio upload may carry a custom `thumbnail` image, on upload or later by `PUT /api/v1/media/:id`
([mastodon-deviations.md](mastodon-deviations.md), "Media"). It runs no container: Images makes it as an image upload,
and it is charged three transformations to the instance's and the account's Images budgets, as an image upload is. On
upload it is made after the file is staged and before the queue, within the staging's own time, and takes no attempt of
its own (the upload's one counts); on `PUT` it counts one attempt. The video's own still is made beside it as without
one, under its own admission, and shows again once the thumbnail is removed. A replaced or removed thumbnail's served
files are deleted by the first successful release batch that lists it; its original is kept 31 days (the point-in-time
window plus a day) so a restore can bring it back.

## Capacity and cleanup

At most two uploads are processed at once (`MAX_AV_INFLIGHT`). An upload's container runs in its own Durable Object,
which keeps a cleanup alarm before it starts anything: a job interrupted at any point is cleaned up by that alarm, and
its capacity slot counts until the container's stop is confirmed, or for at most 24 hours after the job started
(`HARD_HOLD_MS`). A container whose stop never succeeds is retried every minute; past those 24 hours Kopje admits
another upload beside it, and Cloudflare bills that container until it stops. An upload's object keeps its record until
its slot is released and its input deleted; from `V2_PROCESS_MS` + `HARD_HOLD_MS` after it was dispatched, with its
container stopped, it drops the record as soon as the input is deleted.

A container or a call that stops answering does not hold an upload: Kopje waits for the input and the reply until the
job's work deadline, and allocates the time after the reply backwards from that deadline. The last `T_FINISH` (4 s) is
kept for the container's stop, the write grants, the final writes and the completion (measured at p95 2.44 s, at most
3.65 s); the commit stage (`T_COMMIT`, 13 s) adds a 9 s share for the output's transfer into R2 (p95 5.72 s, at most
8.71 s). The input is allotted 16 MiB/s. The still and its preview are optional: they begin after the transfer, get 3 s,
and are skipped when less than 1 s is left (below 2 s, the blurhash alone is skipped). Past the reply's or the
transfer's cut Kopje stops the container and fails the upload as `timeout`; past the preview's, or when it is skipped,
the upload keeps its poster.

The cron also redispatches an upload whose start was lost (after 2 minutes), fails jobs past their deadline, and once an
hour removes inputs under `incoming/` that are more than a day old and held by no upload, probe copies included.

The Containers dashboard lists every destroyed container as "Failed": that is how a container Kopje stops is shown, and
is normal. Each image Kopje builds is about 300 MB in the account's container registry; delete the images of versions
no deployed Worker uses (`npx wrangler containers images list`).

## Remote stills

A remote video or gifv has a still frame of its own as its `preview_url` once Kopje has made one: Mastodon sends no
preview for most videos, and without one Kopje shows `/assets/video-poster.png`. Only a video or gifv attachment whose
file is cached after remote stills were turned on, and that has no preview of its own (none, or one that is the file
itself), gets a still; when the attachment has no blurhash, the still's is shown with it. The still is a WebP of at
most 640 pixels on its long edge, served at `/media/r/<token>/s<attempt>.webp`.

When the cache records such a video, the Store queues its still. The cron's stills round (every 5 minutes) claims at
most one a tick: the claim charges one job of `MEDIA_STILL_MONTHLY_JOBS`, which covers the container, its at most two
Images transformations and one metadata call (`IMAGES_MONTHLY_TRANSFORMS` does not count them), and reserves 2 MiB of
`REMOTE_MEDIA_CACHE_BYTES` until the still is recorded (its real size then) or its attempt fails. A claim waits while
the cache has less room than that below the cap less its 96 MiB headroom: reclamation never evicts anything for a still,
so near the cap the poster stays until ordinary reclamation, retention or eviction makes room. The round makes the
still on a fresh `standard-1` container from the cached file, checks the PNG before Images sees it and Images' WebP
before it is written, and writes it under a key of its own for each attempt. A video gets at most three claims between
restores:

| Outcome                                                                                                                 | Disposition                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| the container refuses the input, or fails to make a still of it (`still_failed`)                                        | parked: the poster stays                                                  |
| the PNG fails Kopje's checks                                                                                            | parked, and the probe is due again (an infrastructure failure)            |
| the still's work is cut after the input reached the container                                                           | parked                                                                    |
| the input is cut before it reached the container, or is missing                                                         | retried                                                                   |
| the container does not become ready, or answers outside the protocol                                                    | retried, and the probe is due again                                       |
| the container dies, or the call is lost                                                                                 | retried                                                                   |
| Images fails for the WebP, 9422 included, or its WebP fails Kopje's checks                                              | parked (Images refusing the PNG as input also makes the probe due)        |
| Images fails only for the blurhash                                                                                      | recorded without a blurhash                                               |
| the Store refuses the write (the video was removed or got a preview of its own, `reject_media`, maintenance, a restore) | retried; a claim that finds the video no longer qualifies drops its still |

A retry is due again 75 minutes after its claim, or 10 minutes (after a first claim) or an hour (after a second) after a
failure that came later; a parked still, or one past its third claim, keeps the poster. While the container's stop is
unconfirmed, the round's lease holds the next claim off for up to 10 minutes; a stop that keeps failing is retried by
its object's alarm, and one more still container may then start beside it. In maintenance or while the Store is
read-only nothing is claimed.

A still that was written but never recorded (its round gave up, or the Store refused its record) is charged nothing and
named by no video. The hourly orphan sweep deletes it once it was uploaded more than 75 minutes earlier while the
cache's ledger holds its token (the video cached, or doomed and awaiting deletion), or 24 hours or more earlier once it
does not; a failed sweep page is listed again an hour later, so no time bounds its removal. Between restores each such
still is at most 2 MiB and at most one is written a cron tick; a restore's backlog is below. A doomed video's deletion
waits 75 minutes after a still's claim, and deletes the video's recorded still with it.

Cost (an estimate): a still runs one `standard-1` container for a few seconds, about 16 GiB-s of memory and 32 GB-s of
disk, and two Images transformations; 200 stills a month are about 3,200 GiB-s, within the Workers Paid allowance. The
Images allowance must cover the Images budgets and 2 × `MEDIA_STILL_MONTHLY_JOBS` ([setup.md](setup.md)).

## Restoring the Store

Before a point-in-time restore of the Store, stop uploads as [backup.md](backup.md), "Media recovery guarantee", says;
after it, a restored slot can keep uploads busy for up to 24 hours.

A restore rewinds the month's spent jobs and each video's claims to the bookmark, so the three claims a video and the
monthly budgets hold between restores. No still is claimed until the restore's validation has walked the cache. A still
the restore forgot (recorded after the bookmark) is named by no video: all of them are deleted as above, a backlog
removed at the sweep's pace, and a new still is made for the video under a new URL once claims resume with budget left,
so a viewer holding the old one gets 404. As for every cached URL after a restore, a still the restored Store names may
answer 404 until validation reaches its video; validation then shows the poster, keeps the video cached and playable,
and queues the still again. This assumes a delete outstanding at the restore has landed or failed before validation
reads the restored still, as the 20 minutes the cache waits after a restore before any maintenance provide in practice;
one landing later leaves the still answering 404, with no reset.

A restore to a bookmark at which a since-replaced custom thumbnail was current brings back its row and its original,
which is kept 31 days after the replacement; its served files were deleted, so its preview answers 404 until
`kopje-admin media-rebuild` ([backup.md](backup.md), restore step 6) makes them again from the original.

## Turning it off

Set `MEDIA_UPLOAD_MONTHLY_JOBS` to 0: uploads of video and audio are refused as an unsupported type, the instance stops
advertising them, the probe round stops probing `normalize@standard-4`, and jobs already queued finish. Set
`MEDIA_STILL_MONTHLY_JOBS` to 0: no remote still is claimed, the queued ones wait, and stills already recorded stay
shown; videos cached meanwhile get none, also once it is raised again. To remove the processor, follow
[deploy/README.md](../../../deploy/README.md), "Video and audio".
