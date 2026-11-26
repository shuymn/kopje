# The media processor

The media processor is the optional container that turns video and audio into the files Kopje serves (#1828), and
that makes still frames of cached remote videos. It is added by the deploy template's "Video and audio" block
([deploy/README.md](../../../deploy/README.md)). This page is for the operator: how it is activated, what an upload and
a remote still cost and answer, what its probes and health report, and how to turn it off. The mechanisms live in
`src/media-processor.ts` (the Durable Object), `src/jobs/media-jobs.ts` (an upload's work and the rounds),
`src/jobs/remote-stills.ts` (the remote stills' round), `src/domain/remote-media-stills.ts` (their Store side),
`src/mastodon/media-av.ts` (the upload route) and `src/mastodon/media-activation.ts` (the activation probes); the rules
are in the [threat model](threat-model.md) (MEDIA-2, MEDIA-4, MEDIA-6, MEDIA-7, MEDIA-8, MEDIA-9, RES-1, RES-6).

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
it. One claim a profile is shared with `kopje-admin media-processor probe` and, for `still@standard-1`, with the media
rebuild's own probe, so no two probe at once, and a claim for the same version is not given again within an hour
(`PROBE_RETRY_MS`) of one that recorded an outcome, or within 5 minutes (`PROBE_CLAIM_MS`) of one that recorded none:
its reply or its record lost, its request cut short, or the probe object busy with an earlier container and starting
none.

The probe of `normalize@standard-4` copies the 2-second clip that ships in the package to `incoming/probe-<nonce>` in
the media bucket, starts the container on standard-4 without Internet access, streams the copy through it, holds the
output to Kopje's verifier with the duration the container declared, checks the still, stops the container, has Images
re-encode the still, and deletes the copy. A copy left by a Worker that died is removed by the orphan pass below. The
container's stop belongs to the probe object, after the probe's work settled or was given up, and Images sees the still
only once that stop is confirmed, so a probe given up at its deadline cannot stop a later probe's container.

The probe is sent only with enough time for the clip to say something of the build: at least `PROBE_FLOOR_MS` (6,568
ms) left once the copy is read, twice the sum of the clip's envelope and its way in. The envelope, 2,284 ms, is the
least encode time the server's plan admits the clip in (`plan.go`: an estimate of 1,598.25 ms for 192x144 H.264 at 15
fps for 2 s with AAC, within 0.7 of the encode time; `plan_test.go` pins it), and the way in (the body and ffprobe), 1
s, is a starting value that the den-test runs measure. Its still reserve is half the work deadline, at most 5 s, room
for contention. Its outcome:

| Outcome      | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Effect                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pass`       | every check passed and Images re-encoded the still (`imagesVerified: true`), or every earlier check passed and Images answered that the month's allowance is used up (9422; `imagesVerified: false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | uploads are admitted; an unverified pass is probed again after an hour |
| `fail`       | only on positive evidence that the build is wrong: its `/healthz` answered 404 or 405, or a complete reply without this protocol's version (an image that does not speak it, such as the one before the work deadline); a route of the protocol answered 404 (bare or `not_found`), or its method 405, judged by the status; a 200 broke the reply's contract (its headers, kind or length, a body longer than declared among it, which its first byte past that length shows); the verifier refused the output's bytes it received or found its declared duration wrong; `verifyStill` refused the still; or Images refused that verified still as input | uploads are refused until a later probe passes                         |
| `no-verdict` | anything else: any code the container answers (`envelope`, `encode_failed`, `internal`, `truncated`, `no_output`, `bad_request`, a refusal of the clip, a 500 naming `not_found`, and every other), a video answered without its still, busy, a gateway's reply, a lost connection, a readiness reply whose body could not be read, a body whose read failed or that ended short of its length before the verifier refused it, less than the clip's floor left to send it, a stage that timed out, Images' own output failing the still's checks, or Images failing another way                                                                           | the last verdict stands; health shows `lastProbe: "unavailable"`       |

An upload whose still Images refuses as input, though the verifier passed it, completes with the default poster and
records an infrastructure failure, which has the next cron probe again; it revokes nothing. A container answer that is
a processing outcome of the input (a 500 such as `encode_failed`) is the upload's own failure, never the processor's.

The probe of `still@standard-1` makes a still of the same clip's copy on standard-1, holds its PNG to `verifyStill` and
has Images re-encode it, with the same outcomes; its `fail` has the same evidence: its `/healthz` or `/still` answers
showing an image that does not speak the protocol (a 404 or 405), `verifyStill` refusing the PNG, or Images refusing it
as input.

`kopje-admin media-processor probe` runs the same probes on request (one profile, or every profile by default) and
records each verdict for the deployed version under the profile's claim, as the cron does, even while that profile's
budget is 0. A profile whose probe was claimed within its cooldown is not run again: it prints `cooldown` and the CLI
exits 1, as it does for any profile whose verdict is not a recorded pass. The still takes a `/healthz` without the
version as ready, since `/still` is unchanged since the image before it: a Worker that activates before its image keeps
the media rebuild's still. Both start a container and write a probe copy to the media bucket, so they are refused while
the instance is in maintenance or its Store is read-only, and the CLI prints that refusal.

The request has one deadline, `PROBE_ROUTE_MS` (290 s, 10 s under the 300 s the CLI's fetch waits for the response's
headers), from its arrival, before its credential is checked. Each step ends at its cut, the earlier of that deadline
and its own bound: the credential check (`adminGate` and the Access token) 10 s, the body 5 s, the Store calls (the
claim, the record) 10 s each, the copy's put and delete 5 s each, the probe object's call 245 s, and
the still probe's Images what is left of its 75 s. A step is not started past the deadline, and an answer at or past its
cut, even one before its timer fires, starts no later step. A credential check or body past its cut answers 504;
a claim or record past its cut answers `unconfirmed`, as does a rejection past it. A probe the probe object refuses
before it starts a container (busy) answers `not_started` and records nothing. A claim that records no result (its reply
lost, or its request cut before its probe or its record) holds the profile for `PROBE_CLAIM_MS` (5 min, longer than any
request), not the hour (`PROBE_RETRY_MS`) a recorded result holds it. A pass whose claim is older than an infrastructure
failure recorded for its build records nothing (`stale`): the failure is the newer evidence. A record already sent may
still commit in the Store after its reply is lost or arrives past its cut, under its claim's fence; that is the Store
finishing a write it received, not work the Worker keeps.

What the Worker keeps past the response is explicit: the probe's work with the copy's delete after it, and a late put's
delete, are handed to `waitUntil`, which outlives a client that disconnects by at most its grace (30 s); a copy left
after that is the orphan pass's. The probe object's container does not depend on the request: its stop is attempted by
its own deadline, `PROBE_MS` + `DESTROY_MS` (210 + 30 s) from its start for normalize and `STILL_CHECK_MS` (75 s, its
teardown included) for the still probe, and a destroy that has not answered by then is retried by the object's alarm,
armed before the start for no later than that deadline, every `CLEANUP_RETRY_MS` until the container is gone.

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

A positive budget without the binding reports `disabled` with `reason: "binding"`, for either budget, where the design
said `degraded`: without the template's block nothing was ever admitted, so nothing is refused. Each state carries the
uploads' month's spent jobs (`spent`), their budget and the capacity slots that count now (`slots`), and `stills` with
the remote stills' spent jobs and budget. Only `degraded` fails the check.

## Uploads

An upload's file is staged into R2 while the request is read (at most 90 MiB, `AV_UPLOAD_LIMIT`), then queued, which
charges one job of `MEDIA_UPLOAD_MONTHLY_JOBS`; a refused or abandoned upload charges nothing. `/api/v2/media` answers
202 at once and the client polls `GET /api/v1/media/:id`. `/api/v1/media` answers within `V1_TIME_MS` of the request's
arrival, its reservation and reading included: it asks for the outcome every 2 seconds, takes its decision `T_REPLY`
(two seconds) before that time, and answers 503 `Media processing took too long. Try a shorter file.` once it passes.
That decision cancels an upload still processing. One decided just before the 503, whose answer the request no longer
sends, keeps the decision: a completed upload stays, unattached, until the sweep deletes unattached media a day later,
and a failed one stays failed; so does one whose decision was not received (its reply lost or failed), which the 503
answers while the processing goes on. Three times are separate. Staging writes to R2 start only within the staging's own
time and, on v1, before the decision's time. The answer is due by `V1_TIME_MS` on v1, every wait before the decision
ending at the decision's time; on v2 the reservation waits as an image's does, and the slot, the queue and the lookup of
an upload already queued are each given 30 s per attempt. Cleanup (aborting a staging, releasing it, deleting its input,
abandoning the reservation) may finish after the answer, in the background, each step given 30 s, all within the 30 s
the Worker lives after the answer; what it leaves the sweep, the `incoming/` orphan pass or R2's lifecycle rule removes.
The route has no disconnect trigger: a client that disconnects starts that cleanup only when the staging ends on its own
(the body's read or an R2 write fails) or the staging's own time ends, while the Worker still lives. An incomplete
staging is left to the bucket's rule aborting incomplete multipart uploads, a slot that is still staging stops counting
at the staging's deadline, and a queue call already sent may still accept the upload, charge it and process it as any
other. When the slot's request finds the processor inactive (its probe failed after the reservation), a v1 request goes
on as an image with the image path's waits: after the 503 it may still deduct three units from the account's and the
instance's Images allowances, image or not, and an image completing then is unattached and swept the same way.
`V1_TIME_MS` is a constant of the release, not a setting: 480 s (8 minutes, `V2_PROCESS_MS`). It was set from a
measurement on a staging instance: Elk's v1 upload in desktop Chrome, Firefox and Playwright's WebKit took an answer
held 600 s and more, so the shortest measured wait less 10 % is past `V2_PROCESS_MS`, which caps it. Safari on iOS and
the mobile apps were not measured; a client that stops waiting sooner shows the upload as failed while it completes,
unattached, and is swept. `T_REPLY` (2 s) covers the decision's round trip, measured at 4–15 ms.

Estimated admission limits. The container refuses a video (422 `Validation failed: File is too long or too large to
process`) whose conservative encode estimate passes 0.7 of the encode time its endpoint leaves. The table gives what
that estimate admits with this release's constants. It is computed from the estimate model (`container/server/plan.go`)
and the time allocation (`allocate` in `src/domain/media-processing.ts`) for a 90 MiB input (the longest input time),
each stage taking its planned time, and on v1 3 s from the request's arrival to the queue. These are estimates, not
measured wall times: measured encodes took 0.38 to 1.08 of their estimate. Every file is also at most 90 MiB, which at
b Mb/s is about 755 / b seconds, and at most 600 s of video or 1200 s of audio.

| Source                                 | `/api/v1/media`                                | `/api/v2/media`            |
| -------------------------------------- | ---------------------------------------------- | -------------------------- |
| H.264 or HEVC, 1080p up to 30 fps, SDR | 600 s                                          | 600 s                      |
| H.264, 1080p60, SDR                    | up to 111 s, and 120–600 s (encoded at 720p30) | up to 113 s, and 120–600 s |
| HEVC, 2160p30, SDR                     | 463 s                                          | 468 s                      |
| HEVC, 2160p30, HDR (tone mapped)       | 69 s                                           | 70 s                       |
| HEVC, 2160p60, HDR (tone mapped)       | 35 s                                           | 35 s                       |
| Audio (MP3 output)                     | 1200 s                                         | 1200 s                     |

At the edges on a staging instance, a 64 s 2160p30 HLG clip (65.8 MB) completed on v2 and a 76 s one was refused, and a
file of exactly 90 MiB completed.

A video is re-encoded to an H.264 and AAC MP4 (at most 1080p at 60 fps up to 120 s, 720p at 30 fps up to 300 s, 480p
at 30 fps up to 600 s), audio to MP3; a longer file, or one past the processing envelope, is refused with 422. Two
uploads at once already processing make a third answer 503 `Media processing is busy. Try again in a moment.`

Cost. An upload runs one `standard-4` container (4 vCPU, 12 GiB of memory, 20 GB of disk) for its wall time W, at most
`V2_PROCESS_MS` (8 minutes) plus its stop: about 12 × W GiB-s of memory, 20 × W GB-s of disk and up to 4 × W vCPU-s
of CPU, billed against the Workers Paid allowance (90,000 GiB-s, 720,000 GB-s and 22,500 vCPU-s a month, shared with
any other container) and at Cloudflare's container prices beyond it. A one-minute 1080p video takes well under two
minutes; the worst job, 8 minutes, is 5,760 GiB-s, so `MEDIA_UPLOAD_MONTHLY_JOBS` × 5,760 GiB-s bounds the month's
memory. Set the budget from that bound and the allowance left for other containers. One account can spend the whole
month's budget ([threat model](threat-model.md), "Accepted risks").

## Capacity and cleanup

At most two uploads are processed at once (`MAX_AV_INFLIGHT`). An upload's container runs in its own Durable Object,
which keeps a cleanup alarm before it starts anything: a job interrupted at any point is cleaned up by that alarm, and
its capacity slot counts until the container's stop is confirmed, or for at most 24 hours after the job started
(`HARD_HOLD_MS`). A container whose stop never succeeds is retried every minute; past those 24 hours Kopje admits
another upload beside it, and Cloudflare bills that container until it stops. An upload's object keeps its record until
its slot is released and its input deleted; from `V2_PROCESS_MS` + `HARD_HOLD_MS` after it was dispatched, with its
container stopped, it drops the record as soon as the input is deleted (a delete that fails is retried every minute
while R2 is down). A container or a call that stops answering does not hold an upload: Kopje waits for the input and the
reply until the job's work deadline. After the reply its time is allocated backwards from the job's deadline. The last
`T_FINISH` (4 s) is kept for the container's stop, the write grants, the final writes and the completion, measured over
50 completed jobs on a staging instance at p95 2.44 s and at most 3.65 s; the commit stage (`T_COMMIT`, 13 s) is
`T_FINISH` and a 9 s share for the output's transfer into R2, measured at p95 5.72 s and at most 8.71 s. The input is
allotted 16 MiB/s (a 68 MB input took at most 3.15 s). The transfer, which every upload needs, may run until `T_FINISH`
before the deadline, using whatever time the encode left. The still and its preview are optional: they begin after the
transfer, get 3 s within the same bound, and are skipped when less than 1 s is left (the WebP's share of the 3 s; below
2 s left, the blurhash alone is skipped). Past the reply's or the transfer's cut Kopje aborts the requests, stops the
container and fails the upload as `timeout`; past the preview's, or when it is skipped, the upload keeps its poster.

The cron also redispatches an upload whose start was lost (after 2 minutes), fails jobs past their deadline, and once an
hour removes inputs under `incoming/` that are more than a day old and held by no upload, probe copies included.

The Containers dashboard lists every destroyed container as "Failed": that is how a container Kopje stops is shown, and
is normal. Each image Kopje builds is about 300 MB in the account's container registry; delete the images of versions
no deployed Worker uses (`npx wrangler containers images list`). A colour profile the encoder cannot use is dropped and
the video is encoded under the BT.709 label (design #1828, A5).

## Remote stills

A remote video or gifv has a still frame of its own as its `preview_url` once Kopje has made one: Mastodon sends no
preview for most videos, and without one Kopje shows `/assets/video-poster.png`. Only a video or gifv attachment whose
file is cached after remote stills were turned on, and that has no preview of its own (none, or one that is the file
itself), gets a still; when the attachment has no blurhash, the still's is shown with it. The still is a WebP of at
most 640 pixels on its long edge, served at `/media/r/<token>/s<attempt>.webp`.

When the cache records such a video, the Store queues its still. The cron's stills round (every 5 minutes, on its own)
claims at most one a tick: the claim charges one job of `MEDIA_STILL_MONTHLY_JOBS`, which covers the container and its
at most two Images transformations and one metadata call (the WebP, its `info()` and the blurhash's RGBA;
`IMAGES_MONTHLY_TRANSFORMS` does not count them), and reserves 2 MiB of `REMOTE_MEDIA_CACHE_BYTES` until the still is
recorded (its real size then) or its attempt fails. A claim waits while the cache has less room than that below the cap
less its 96 MiB headroom: reclamation never evicts anything for a still, so near the cap the poster stays until ordinary
reclamation, retention or eviction makes room. The round makes the still on a fresh `standard-1` container from the
cached file, checks the PNG before Images sees it and Images' WebP before it is written, and writes it under a key of
its own for each attempt, after a Store admission whose grant lasts 2 s. A video gets at most three claims between
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
named by no video. It becomes eligible for the hourly orphan sweep once uploaded more than 75 minutes earlier while the
cache's ledger holds its token (the video cached, or doomed and awaiting deletion), or 24 hours or more earlier once it
does not (counted from the upload, not from the token leaving the ledger), and is deleted when a sweep page listing it
succeeds; a failed page is listed again an hour later, so no time bounds its removal. Between restores each such still
is at most 2 MiB and at most one is written a cron tick; a restore's backlog is below. A doomed video's deletion waits
75 minutes after a still's claim, and deletes the video's recorded still with it.

Cost (an estimate from the design, to be replaced by the den-test measurement): a still runs one `standard-1`
container for a few seconds, about 16 GiB-s of memory and 32 GB-s of disk, and two Images transformations; 200 stills a
month are about 3,200 GiB-s, within the Workers Paid allowance. The Images allowance must cover the Images budgets and
2 × `MEDIA_STILL_MONTHLY_JOBS` ([setup.md](setup.md)).

## Restoring the Store

Before a point-in-time restore of the Store, set `MEDIA_UPLOAD_MONTHLY_JOBS` to 0 and wait until health shows no slot
in use. After it, a restored slot can make uploads answer busy until its job's deadline, or for up to 24 hours if its
job had started, until the processor confirms its stop ([backup.md](backup.md), "Media recovery guarantee").

A restore rewinds the month's spent jobs and each video's claims to the bookmark, so the three claims a video and the
monthly budgets hold between restores. No still is claimed until the restore's validation has walked the cache. A still
the restore forgot (recorded after the bookmark) is named by no video: all of them are unnamed at once and deleted as
above, a backlog removed at the sweep's pace, and a new still is made for the video under a new URL once claims resume
with budget left, so a viewer holding the old one gets 404. As for every cached URL after a restore, a still the
restored Store names may answer 404 until validation reaches its video (its file was deleted before or during the
restore); validation then shows the poster, keeps the video cached and playable, and queues the still again, made anew
once claims resume with budget left and stills on. This assumes a delete outstanding at the restore has landed or failed
before validation reads the restored still, as the 20 minutes the cache waits after a restore before any maintenance
provide in practice; one landing later leaves the still answering 404, with no reset.

## Turning it off

Set `MEDIA_UPLOAD_MONTHLY_JOBS` to 0: uploads of video and audio are refused as an unsupported type, the instance stops
advertising them, the probe round stops probing `normalize@standard-4`, and jobs already queued finish. Set
`MEDIA_STILL_MONTHLY_JOBS` to 0: no remote still is claimed, the queued ones wait, and stills already recorded stay
shown; videos cached meanwhile get none, also once it is raised again. To remove the processor, follow
[deploy/README.md](../../../deploy/README.md), "Video and audio".
