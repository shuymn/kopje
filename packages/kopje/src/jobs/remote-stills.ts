import { STILL_PROFILE } from "../domain/media-probes";
import { STILL_ROUND_MS } from "../domain/remote-media";
import type { RemoteStillClaim, RemoteStillFailure } from "../domain/remote-media-stills";
import { pngSize } from "../mastodon/media-activation";
import { verifyStill } from "../platform/av-bytes";
import { DeadlinePassed, inTime } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { type ImageCodec, stillPreview } from "../platform/images";
import { remoteFileKey } from "../platform/media-files";
import type { StillMaker, StillOutcome } from "../platform/media-transcoder";
import type { StoreStub } from "../platform/store-client";

// The remote stills' round (#1828 PR5; MEDIA-6, MEDIA-7, MEDIA-8 and RES-6 in docs/threat-model.md): at most one still a
// cron tick, on its own (jobs/scheduled.ts scheduledRemoteStills), for a cached remote video or gifv the Store queued
// (domain/remote-media.ts queueStill). Without the processor's binding or with MEDIA_STILL_MONTHLY_JOBS 0 it returns
// before any Store call. Otherwise, each step started only when its budget fits what is left of STILL_ROUND_MS from the
// round's start (which precedes the claim's Store time, so the record's Store fence, claimed_at + STILL_ROUND_MS, is
// never the tighter one in the normal case):
//   claim       claimRemoteStill (STORE_MS): one unit, the reservation, a fresh attempt, the lease (remote-media-stills.ts)
//   make        StillMaker.remote on s:<token>:<attempt>, input remote/<token>/full (STILL_CALL_MS and its way back)
//   check       verifyStill before any Images call (MEDIA-9), then Images' WebP and RGBA (stillPreview, at most two
//               calls, IMAGES_MS, uncounted by IMAGES_MONTHLY_TRANSFORMS: the claim's unit covers them), the WebP held to
//               stillWebpSize inside it before any put (MEDIA-6)
//   admission   admitRemoteStill, the Worker's clock read before the call: its grant starts one put only within
//               STILL_PUT_GRANT_MS of that reading, read again at the put's start, and with the invocation's env
//               not in maintenance
//   put         remote/<token>/s<attempt>, image/webp, a plain put (a key per attempt: nothing is adopted), within PUT_MS
//   record      recordRemoteStill, the slot naming the still
// and a failure settled once, with the disposition `disposition` gives (design 4.14), the lease kept only when the
// container's stop is not known. Two Store calls are kept for the end: the record, and the failure after a refused
// record. A put given up may still land: its key is one no row names, which the hourly sweep deletes (MEDIA-2).

// The admission's grant: a put starts only within this of the Worker's reading before the call (as AV_GRANT_MS).
export const STILL_PUT_GRANT_MS = 2_000;
// A Store call of the round: the claim, the admission, the record or the failure.
const STORE_MS = 5_000;
// The still's call: media-processor.ts STILL_CALL_MS (its object bounds it so), and its way back over the RPC.
export const REMOTE_STILL_CALL_MS = 75_000;
const CALL_WAY_MS = 5_000;
// Images' two calls, 10 s each.
const IMAGES_MS = 20_000;
const PUT_MS = 15_000;

// The container's answers that show it did not become ready, which say the build or the platform cannot run a still.
const READINESS = new Set(["ready", "healthz", "no-image"]);

export type RemoteStillsDeps = {
  build: string;
  store: StoreStub;
  bucket: Pick<R2Bucket, "put">;
  // null without the processor's binding.
  stills: StillMaker | null;
  images: ImageCodec;
  // MEDIA_STILL_MONTHLY_JOBS and REMOTE_MEDIA_CACHE_BYTES.
  budget: number;
  cap: number;
  // The invocation's env holds it in maintenance (its snapshot, jobs/scheduled.ts remoteStillsDeps): rechecked right
  // before the put.
  maintenance: () => boolean;
  now: () => number;
};

// What a failed attempt is settled as: retried or parked (design 4.14), whether the lease is kept (the container's stop
// unknown: a lost answer or an unconfirmed destroy), and whether it records an infrastructure failure of
// still@standard-1 (the build's or the platform's evidence, which makes the profile due for a probe).
type Disposition = {
  outcome: "retry" | "park";
  keepLease: boolean;
  infrastructure: boolean;
  reason: string;
};

// The disposition of the container's answer for a still that failed (#1828 PR5 plan, 1.4).
function disposition(out: Extract<StillOutcome, { ok: false }>): Disposition {
  const reason = out.failure;
  const settle = (outcome: "retry" | "park", infrastructure = false, keepLease = false): Disposition => ({
    outcome,
    keepLease,
    infrastructure,
    reason,
  });
  // The destroy did not finish: the lease holds the next claim off until the object's alarm has stopped it.
  if (out.pending === true) {
    return settle("retry", false, true);
  }
  // The container refused the input itself, or failed to make a still of it: the input's outcome.
  if (out.input !== undefined || reason === "still:still_failed") {
    return settle("park");
  }
  // The image does not speak the protocol, or did not become ready: the container's start.
  if (out.evidence !== undefined || READINESS.has(reason)) {
    return settle("retry", true);
  }
  // Cut after the input drained into the request body: the encode past its stage's deadline.
  if (reason === "operation-deadline") {
    return settle("park");
  }
  // No answer over the RPC: whether a container started, and whether it stopped, is not known.
  if (reason === "unavailable") {
    return settle("retry", false, true);
  }
  // The input's streaming (input-deadline, input-missing), a death mid-job (internal, operation, late, a short body),
  // or a refusal before any start (busy, storage, no container): retried, the stop known.
  return settle("retry");
}

export type RemoteStillsRound =
  // No binding, or no budget: no Store call.
  | { status: "off" }
  | { status: "unclaimed"; claim: RemoteStillClaim }
  | { status: "recorded"; token: string; attempt: string; bytes: number }
  | {
      status: "failed";
      token: string;
      attempt: string;
      disposition: Disposition;
      // The Store's answer to the failure, or null when it did not answer in time.
      settled: RemoteStillFailure | null;
    }
  // The record's answer did not come in time: committed or not, the Store decides (a repeat answers `recorded`).
  | { status: "unconfirmed"; token: string; attempt: string };

// The end of an operation of `budget` ms started now within an allocation ending at `end`, or null when it does not fit.
function fits(budget: number, end: number, now: () => number): number | null {
  const at = now();
  return at + budget <= end ? at + budget : null;
}

export async function remoteStillsRound(deps: RemoteStillsDeps): Promise<RemoteStillsRound> {
  const stills = deps.stills;
  if (stills === null || !Number.isSafeInteger(deps.budget) || deps.budget <= 0) {
    return { status: "off" };
  }
  const { build, now } = deps;
  const end = now() + STILL_ROUND_MS;
  // The record's call and the failure's after it are kept from the work.
  const recordEnd = end - STORE_MS;
  const workEnd = recordEnd - STORE_MS;
  const store = <T>(call: () => Promise<T>, until: number): Promise<T> => {
    const by = fits(STORE_MS, until, now);
    if (by === null) {
      return Promise.reject(new DeadlinePassed());
    }
    return inTime(call, by, now);
  };

  const claim = await store(
    () =>
      deps.store.claimRemoteStill(build, {
        binding: true,
        budget: deps.budget,
        build,
        cap: deps.cap,
      }) as Promise<RemoteStillClaim>,
    workEnd,
  );
  if (claim.status !== "claimed") {
    return { status: "unclaimed", claim };
  }
  const { token, attempt } = claim;

  const fail = async (settle: Disposition): Promise<RemoteStillsRound> => {
    let settled: RemoteStillFailure | null = null;
    try {
      settled = await store(
        () =>
          deps.store.failRemoteStill(build, {
            token,
            attempt,
            outcome: settle.outcome,
            keepLease: settle.keepLease,
          }) as Promise<RemoteStillFailure>,
        end,
      );
    } catch (error) {
      if (!(error instanceof DeadlinePassed)) {
        console.warn({ event: "kopje.media.still.remote_settle_failed", ...errorFields(error) });
      }
    }
    console.warn({
      event: "kopje.media.still.remote_failed",
      outcome: settle.outcome,
      reason: settle.reason,
      settled: settled?.status ?? "unconfirmed",
    });
    if (settle.infrastructure) {
      // Makes still@standard-1 due for a probe; admission stands until a probe fails (media-probes.ts).
      await store(
        () => deps.store.recordMediaInfrastructureFailure(build, { profile: STILL_PROFILE, build }),
        end,
      ).catch(() => {});
    }
    return { status: "failed", token, attempt, disposition: settle, settled };
  };
  // A retry whose container's stop is known (none started, or its stop confirmed): the lease goes with it.
  const retried = (reason: string) => fail({ outcome: "retry", keepLease: false, infrastructure: false, reason });

  // ---- make
  const callEnd = fits(REMOTE_STILL_CALL_MS + CALL_WAY_MS, workEnd, now);
  if (callEnd === null) {
    return retried("budget");
  }
  let out: StillOutcome;
  try {
    out = await inTime(() => stills.remote(token, attempt, REMOTE_STILL_CALL_MS), callEnd, now);
  } catch (error) {
    if (!(error instanceof DeadlinePassed)) {
      console.warn({ event: "kopje.media.still.remote_call_failed", ...errorFields(error) });
    }
    out = { ok: false, failure: "unavailable", image: null };
  }
  if (!out.ok) {
    return fail(disposition(out));
  }

  // ---- check: the PNG before any Images call, then Images' WebP (held to stillWebpSize) and RGBA
  const png = out.png;
  if (verifyStill(png) !== null) {
    return fail({ outcome: "park", keepLease: false, infrastructure: true, reason: "verify" });
  }
  const imagesEnd = fits(IMAGES_MS, workEnd, now);
  if (imagesEnd === null) {
    return retried("budget");
  }
  let made: Awaited<ReturnType<typeof stillPreview>>;
  try {
    made = await stillPreview(deps.images, png, pngSize(png), { end: imagesEnd, now }, (work) =>
      inTime(work, imagesEnd, now),
    );
  } catch {
    made = { ok: false, reason: "failed" };
  }
  if (!made.ok) {
    // Images refusing a PNG verifyStill passed says the profile's stills are not usable, as for an upload's poster.
    return fail({
      outcome: "park",
      keepLease: false,
      infrastructure: made.reason === "unsupported",
      reason: `images:${made.reason}`,
    });
  }
  const webp = made.small.bytes;

  // ---- admission, then the put within its grant
  if (fits(STORE_MS + PUT_MS, workEnd, now) === null) {
    return retried("budget");
  }
  const asked = now();
  let granted = false;
  try {
    granted = (await store(() => deps.store.admitRemoteStill(build, { token, attempt }), workEnd)).admitted;
  } catch {
    granted = false;
  }
  if (!granted || deps.maintenance()) {
    return retried("admission");
  }
  // The grant is read last, in the put's own callback: no clock read after it comes before the put starts.
  let expired = false;
  try {
    await inTime(
      () => {
        if (now() - asked > STILL_PUT_GRANT_MS) {
          expired = true;
          return Promise.reject(new DeadlinePassed());
        }
        return deps.bucket.put(remoteFileKey(token, `s${attempt}`), webp, {
          httpMetadata: { contentType: "image/webp" },
        });
      },
      Math.min(now() + PUT_MS, workEnd),
      now,
    );
  } catch (error) {
    if (expired) {
      return retried("admission");
    }
    if (!(error instanceof DeadlinePassed)) {
      console.warn({ event: "kopje.media.still.remote_put_failed", ...errorFields(error) });
    }
    return retried("put");
  }

  // ---- record
  let recorded: { status: "recorded" | "refused" };
  try {
    recorded = await store(
      () =>
        deps.store.recordRemoteStill(build, {
          token,
          attempt,
          facts: { bytes: webp.byteLength, blurhash: made.blurhash },
        }),
      recordEnd,
    );
  } catch {
    console.warn({ event: "kopje.media.still.remote_unconfirmed" });
    return { status: "unconfirmed", token, attempt };
  }
  if (recorded.status !== "recorded") {
    // The attempt is stale, past its deadline, or its slot no longer holds: its reservation is released and its key,
    // which no row names, is the sweep's.
    return retried("record");
  }
  console.log({ event: "kopje.media.still.remote_recorded", bytes: webp.byteLength });
  return { status: "recorded", token, attempt, bytes: webp.byteLength };
}
