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

Once a release turns uploads on, uploads of video and audio are active when all three hold, for the Worker version
that is deployed. In this release they make the processor `ready` in health's `mediaProcessor` and nothing more: an
upload of video or audio still answers 422.

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
`kopje-admin media-processor probe normalize@standard-4`, so the two never probe at once, and a claim for the same
version is not given again within an hour (`PROBE_RETRY_MS`) of one that recorded an outcome, or within 5 minutes
(`PROBE_CLAIM_MS`) of one that recorded none: its reply or its record lost, its request cut short, or the probe object
busy with an earlier container and starting none.

The probe copies the 2-second clip that ships in the package to `incoming/probe-<nonce>` in the media bucket, starts the
container on standard-4 without Internet access, streams the copy through it, holds the output to Kopje's verifier with
the duration the container declared, checks the still, stops the container, has Images re-encode the still, and deletes
the copy. A copy left by a Worker that died is removed by the orphan pass below. The container's stop belongs to the
probe object, after the probe's work settled or was given up, and Images sees the still only once that stop is
confirmed, so a probe given up at its deadline cannot stop a later probe's container.

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

`kopje-admin media-processor probe` runs the same probe on request (`normalize@standard-4`, or every profile by
default). For `still@standard-1` the command is a check: a still of the packaged clip on standard-1, its PNG through
Kopje's checks and Images, with the same outcomes, and nothing recorded, because the media rebuild records its own probe
of that profile under its lease, and its `fail` has the same evidence: its `/healthz` or `/still` answers showing an
image that does not speak the protocol (a 404 or 405), `verifyStill` refusing the PNG, or Images refusing it as input.
The still takes a `/healthz` without the version as ready, since `/still` is unchanged since the image before it: a
Worker that activates before its image keeps the media rebuild's still. Both start a container and write a probe copy to
the media bucket, so they are refused while the instance is in maintenance or its Store is read-only, and the CLI prints
that refusal.

The request has one deadline, `PROBE_ROUTE_MS` (290 s, 10 s under the 300 s the CLI's fetch waits for the response's
headers), from its arrival, before its credential is checked. Each step ends at its cut, the earlier of that deadline
and its own bound: the credential check (`adminGate` and the Access token) 10 s, the body 5 s, the Store calls (the
check's health, the claim, the record) 10 s each, the copy's put and delete 5 s each, the probe object's call 245 s, and
the still check's Images what is left of its 75 s. A step is not started past the deadline, and an answer at or past its
cut, even one before its timer fires, starts no later step. A credential check, body or health past its cut answers 504;
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
teardown included) for the still check, and a destroy that has not answered by then is retried by the object's alarm,
armed before the start for no later than that deadline, every `CLEANUP_RETRY_MS` until the container is gone.

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
another upload beside it, and Cloudflare bills that container until it stops. An upload's object keeps its record until
its slot is released and its input deleted; from `V2_PROCESS_MS` + `HARD_HOLD_MS` after it was dispatched, with its
container stopped, it drops the record as soon as the input is deleted (a delete that fails is retried every minute
while R2 is down). A container or a call that stops answering does not hold an upload: Kopje waits for the input and the
reply until the job's work deadline. After the reply its time is allocated backwards from the job's deadline. The last
`T_FINISH` (1.5 s) is kept for the container's stop, the write grants, the final writes and the completion: a starting
value, the plan's 6 s commit stage less the 4.5 s measured for the output's transfer into R2, which PR4-4's edge runs on
den-test measure. The transfer, which every upload needs, may run until then, using whatever time the encode left. The
still and its preview are optional: they begin after the transfer, get 3 s within the same bound, and are skipped when
less than 1 s is left (the WebP's share of the 3 s; below 2 s left, the blurhash alone is skipped). Past the reply's or
the transfer's cut Kopje aborts the requests, stops the container and fails the upload as `timeout`; past the preview's,
or when it is skipped, the upload keeps its poster.

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
