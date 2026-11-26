import { PUBLISH_ROUND } from "../domain/scheduled-statuses";
import { type CardImagesDeps, cardImagesRound } from "../federation/card-images";
import { ringDoorbell } from "../federation/delivery";
import { type FieldLinksDeps, fieldLinksRound } from "../federation/field-links";
import { type LinkCardsDeps, linkCardsRound } from "../federation/link-cards";
import { type RemoteMediaDeps, remoteMediaRound } from "../federation/remote-media";
import { reconcileMedia, sweepMedia, type SweepDeps } from "../mastodon/media";
import { envInMaintenance, readConfig } from "../platform/config";
import { DeadlinePassed } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import type { ImageCodec } from "../platform/images";
import type { MediaProcessorClient, StillMaker } from "../platform/media-transcoder";
import { callStore } from "../platform/store-client";
import type { StoreResolver } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";
import { incomingOrphans, mediaDispatchRound, mediaProbeRound } from "./media-jobs";
import { remoteStillsRound, type RemoteStillsDeps } from "./remote-stills";

// The 5-minute cron (wrangler.jsonc). Nothing runs while the env sets maintenance (or is invalid), as for the queue; in
// the Store's own maintenance its writes are refused and each task waits for the next run.
//   - media: deletes one batch of doomed uploads and their R2 objects (domain/media.ts), then the R2 keys of one batch
//     of tombstones that fell due. Both are refused by the Store in maintenance, a dump or an import, and do nothing
//     in a Store that is not set up.
//   - /setup: records that the cron ran.
//   - scheduled statuses: publishes up to PUBLISH_ROUND that are due, each in its own transaction that deletes it, then
//     rings the delivery doorbell for what they record (domain/scheduled-statuses.ts). In the Store's maintenance or
//     readonly state nothing is published and what is due waits for the next run.
//   - announcements: one round (domain/announcements.ts announcementRound): publishes the scheduled ones that are due
//     and takes down the published ones that ended, at most the live cap of each. In the Store's maintenance or
//     readonly state, they wait.
//   - trends: one round (domain/trends.ts trendsRound): the hashtags and statuses that trend, scored again from the
//     stored statuses within bounded windows, and kept within their pools. In the Store's maintenance or readonly
//     state, it waits.
//   - polls: one round (domain/polls.ts): ends up to POLL_ROUND polls whose time has come (the 'poll' notifications,
//     once, and a local poll's final Update), and records up to POLL_ROUND Updates of local polls' counts that are due,
//     then rings the delivery doorbell for what they record. In the Store's maintenance or readonly state, they wait.
//   - OAuth: removes apps nobody used for a day (RES-6) and expired codes and web sessions (domain/oauth.ts).
//   - instance activity: deletes the counts and logins outside the kept days, at most ACTIVITY_PRUNE_ROWS of each
//     (domain/instance-activity.ts pruneActivity). In the Store's maintenance or readonly state, they wait.
//   - collections: deletes the rejected and revoked items unchanged for a day, at most RETIRED_ROWS_PER_ROUND
//     (domain/collections.ts pruneCollectionItems). In the Store's maintenance or readonly state, they wait.
//   - instance counts: refreshes the kept peer domain count /api/v1/instance presents (domain/instance.ts
//     refreshDomainCount), one walk of the remote accounts. It is also kept in the Store's readonly state; a skipped
//     refresh leaves the count to age out (DOMAIN_COUNT_FRESH_MS), and requests then count it.
export type ScheduledDeps = SweepDeps & {
  now: () => number;
  // Rings the delivery doorbell after statuses are published (default: a message on env.QUEUE).
  doorbell?: (env: Env) => Promise<void>;
  // The object id (uuid) of each status published.
  objectId?: () => string;
};

export async function handleScheduled(env: Env, deps: ScheduledDeps): Promise<void> {
  if (envInMaintenance(env)) {
    return;
  }
  const store = () => deps.store(env);
  // The marker /setup's cron check reads (domain/setup.ts).
  await cronStep(
    () => callStore(() => store().recordCronRun(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.cron_marker_failed",
  );
  await cronStep(() => publishScheduled(env, deps), "kopje.scheduled.publish_round_failed");
  await cronStep(
    () => callStore(() => store().announcementRound(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.announcement_round_failed",
  );
  await cronStep(
    () => callStore(() => store().trendsRound(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.trends_round_failed",
  );
  await cronStep(() => endPolls(env, deps), "kopje.scheduled.poll_round_failed");
  await cronStep(() => sweepMedia(env, deps), "kopje.scheduled.media_sweep_failed", false);
  await cronStep(() => reconcileMedia(env, deps), "kopje.scheduled.media_reconcile_failed", false);
  await cronStep(
    () => callStore(() => store().sweepOAuth(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.oauth_sweep_failed",
  );
  await cronStep(
    () => callStore(() => store().pruneActivity(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.activity_prune_failed",
  );
  await cronStep(
    () => callStore(() => store().pruneCollectionItems(deps.build(env), { now: deps.now() })),
    "kopje.scheduled.collection_prune_failed",
  );
  await cronStep(
    () => callStore(() => store().refreshDomainCount(deps.build(env))),
    "kopje.scheduled.domain_count_failed",
  );
}

// The cron's field link round (federation/field-links.ts), run first and on its own (worker.ts), so that no other
// scheduled work's failure skips it and its failure skips none: one claimed account per tick, outside the env's
// maintenance; in the Store's, the claim is refused before any request and the check waits for a later tick.
export async function scheduledFieldLinks(env: Env, deps: FieldLinksDeps): Promise<void> {
  await cronRound(env, () => fieldLinksRound(env, deps), "kopje.scheduled.field_links_failed");
}

// The cron's link card round (federation/link-cards.ts), on its own as the field link round is: at most
// CARD_ROUND_CLAIMS cards per tick, outside the env's maintenance; in the Store's, the claim is refused before any
// request and the cards wait for a later tick.
export async function scheduledLinkCards(env: Env, deps: LinkCardsDeps): Promise<void> {
  await cronRound(env, () => linkCardsRound(env, deps), "kopje.scheduled.link_cards_failed");
}

// The cron's card image round (federation/card-images.ts), on its own as the link card round is: at most
// CARD_IMAGE_ROUND_CLAIMS images per tick, outside the env's maintenance; in the Store's, the claim is refused before
// any request and the images wait for a later tick.
export async function scheduledCardImages(env: Env, deps: CardImagesDeps): Promise<void> {
  await cronRound(env, () => cardImagesRound(env, deps), "kopje.scheduled.card_images_failed");
}

// The cron's remote media round (federation/remote-media.ts), on its own as the card image round is: the cache's
// maintenance and at most LANE0_CLAIMS files per tick, outside the env's maintenance; in the Store's, the maintenance
// call is refused before any R2 operation or request, and the files wait for a later tick.
export async function scheduledRemoteMedia(env: Env, deps: RemoteMediaDeps): Promise<void> {
  await cronRound(env, () => remoteMediaRound(env, deps), "kopje.scheduled.remote_media_failed");
}

// The media processor's rounds (jobs/media-jobs.ts), each its own error boundary, run on their own (worker.ts): the
// dispatch round (S12 and S13: the Store's transitions, then a run for each pending upload it hands back), the probe
// round (each profile's activation probe when it is due, only with the binding and that profile's budget positive:
// MEDIA_UPLOAD_MONTHLY_JOBS for normalize@standard-4, MEDIA_STILL_MONTHLY_JOBS for still@standard-1), and the incoming/
// orphan pass (at most one claim an hour). In the Store's maintenance
// each is refused before any R2 operation or container start.
export type MediaRoundsDeps = {
  build: (env: Env) => string;
  store: StoreResolver;
  processor: (env: Env) => MediaProcessorClient | null;
  images: (env: Env) => ImageCodec;
};

export async function scheduledMedia(env: Env, deps: MediaRoundsDeps): Promise<void> {
  const config = readConfig(env);
  const processor = deps.processor(env);
  const round = {
    build: deps.build(env),
    store: deps.store(env),
    bucket: env.MEDIA,
    processor: processor?.uploads ?? null,
    budget: config.ok ? config.config.MEDIA_UPLOAD_MONTHLY_JOBS : 0,
    stills: processor?.stills ?? null,
    images: deps.images(env),
    stillsBudget: config.ok ? config.config.MEDIA_STILL_MONTHLY_JOBS : 0,
  };
  await cronRound(env, () => mediaDispatchRound(round), "kopje.scheduled.media_dispatch_failed");
  await cronRound(env, () => mediaProbeRound(round), "kopje.scheduled.media_probe_failed");
  await cronRound(env, () => incomingOrphans(round), "kopje.scheduled.media_orphans_failed");
}

// The cron's remote stills round (jobs/remote-stills.ts), on its own as the remote media round is: at most one still a
// tick, outside the env's maintenance; without the processor's binding, with MEDIA_STILL_MONTHLY_JOBS 0 or an invalid
// configuration it makes no Store call, and in the Store's maintenance the claim is refused before any container
// starts.
export type RemoteStillsRoundDeps = {
  build: (env: Env) => string;
  store: StoreResolver;
  stills: (env: Env) => StillMaker | null;
  images: (env: Env) => ImageCodec;
  now: () => number;
};

// The round's dependencies from the invocation's env, or null for an invalid configuration. The maintenance recheck
// before the put reads the env as the invocation was given it: Workers hand each invocation a fixed env, and readConfig
// memoizes it, so a change of MAINTENANCE takes effect from the next invocation; the Store's own gates are read at the
// admission.
export function remoteStillsDeps(env: Env, deps: RemoteStillsRoundDeps): RemoteStillsDeps | null {
  const config = readConfig(env);
  if (!config.ok) {
    return null;
  }
  return {
    build: deps.build(env),
    store: deps.store(env),
    bucket: env.MEDIA,
    stills: deps.stills(env),
    images: deps.images(env),
    budget: config.config.MEDIA_STILL_MONTHLY_JOBS,
    cap: config.config.REMOTE_MEDIA_CACHE_BYTES,
    maintenance: () => envInMaintenance(env),
    now: deps.now,
  };
}

export async function scheduledRemoteStills(env: Env, deps: RemoteStillsRoundDeps): Promise<void> {
  // Its dependencies are built only past the maintenance gate.
  await cronRound(
    env,
    async () => {
      const round = remoteStillsDeps(env, deps);
      return round === null ? null : remoteStillsRound(round);
    },
    "kopje.scheduled.remote_stills_failed",
  );
}

// One step of the cron, its own error boundary: a failure is logged as `event` and stops no later step. A Store
// refusal, which the step waits out until the next run, is logged only when `quietRefusal` is false.
async function cronStep(step: () => Promise<unknown>, event: string, quietRefusal = true): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (!(quietRefusal && error instanceof StoreUnavailableError)) {
      console.error({ event, ...errorFields(error) });
    }
  }
}

// A Worker round run on its own outside the env's maintenance: a Store refusal or a passed deadline ends it unlogged,
// and its items wait for a later tick.
async function cronRound(env: Env, round: () => Promise<unknown>, event: string): Promise<void> {
  if (envInMaintenance(env)) {
    return;
  }
  try {
    await round();
  } catch (error) {
    if (!(error instanceof StoreUnavailableError) && !(error instanceof DeadlinePassed)) {
      console.error({ event, ...errorFields(error) });
    }
  }
}

// One round of scheduled statuses (RES-6): at most PUBLISH_ROUND, the earliest due first.
export async function publishScheduled(env: Env, deps: ScheduledDeps): Promise<void> {
  const objectId = deps.objectId ?? (() => crypto.randomUUID());
  const objectIds = Array.from({ length: PUBLISH_ROUND }, objectId);
  const round = await callStore(() =>
    deps.store(env).publishScheduled(deps.build(env), { now: deps.now(), objectIds }),
  );
  if (round.failed > 0) {
    console.error({ event: "kopje.scheduled.publish_failed", failed: round.failed });
  }
  if (round.published > 0) {
    await (deps.doorbell ?? ((e: Env) => ringDoorbell(e.QUEUE)))(env);
  }
}

// One round of polls (RES-6): the ends and the Updates of counts that are due.
export async function endPolls(env: Env, deps: ScheduledDeps): Promise<void> {
  const round = await callStore(() => deps.store(env).pollRound(deps.build(env), { now: deps.now() }));
  if (round.ended > 0 || round.updated > 0) {
    await (deps.doorbell ?? ((e: Env) => ringDoorbell(e.QUEUE)))(env);
  }
}
