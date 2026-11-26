import { probeImageTag, PROBE_RETRY_MS } from "../domain/media-probes";
import {
  avMetaFits,
  type RebuildProbeClaim,
  type RebuildAv,
  type RebuildCharge,
  type RebuildRecord,
  type RebuildRow,
} from "../domain/media-rebuild";
import {
  AV_OUTPUT_LIMIT,
  AvRefusal,
  type AvType,
  avVerifier,
  STILL_OUTPUT_LIMIT,
  verifyStill,
} from "../platform/av-bytes";
import { DeadlinePassed, within } from "../platform/deadline";
import { toHex } from "../platform/hex";
import {
  type ImageCodec,
  type Size,
  stillBlurhash,
  stillEncodes,
  stillPreview,
  stillWebpSize,
} from "../platform/images";
import { fileKey, originalKey, probeInputKey } from "../platform/media-files";
import type { ProbeVerdict, StillMaker, StillOutcome } from "../platform/media-transcoder";
import type { ImportAuthority } from "../platform/store-admin";
import type { StoreStub } from "../platform/store-client";
import { storedBlurhash } from "../platform/stored-bounds";
import { imagesVerdict, NOT_STARTED, pngSize, stillProbeVerdict } from "./media-activation";

// The media rebuild of a video or audio row (#1828 design 4.16; mastodon/media-rebuild.ts runs the call, its lease and
// its fences). Its served `full` is the verified output the original already is (D11), and a video's `small` is the
// still the media processor makes, re-encoded by Images. In order:
//
//   full   when missing, originals/<id> is read once and streamed through the output verifier (avVerifier) into a put
//          of files/<token>/full. The last chunk is held back until the verifier accepted the whole stream and its kind
//          is the row's, so R2 never receives every byte of a refused file; a refusal, a source that ends early or the
//          stage's deadline errors the stream, and the put fails.
//   small  for a video with a preview (or, with `--stills`, without one). Every small Kopje writes carries custom
//          metadata {width, height, blurhash}, the blurhash "" when it has none. An existing small is adopted as it
//          is: read within STILL_OUTPUT_LIMIT, it must walk as a still WebP with no retained metadata and a long edge
//          of at most STILL_LONG_EDGE; its geometry is the object's own, its blurhash the metadata's when that is
//          valid. Metadata that is missing or invalid has its blurhash recomputed by Images (charged), and the same
//          bytes are put again with the metadata, so the next run's skip holds. A missing small is made: the
//          `still@standard-1` probe passed for this build (run first when not, below), the row charged (Images as an
//          upload and one upload unit, chargeRebuild), the StillMaker's PNG through verifyStill, Images' WebP and its
//          RGBA blurhash (stillPreview), then the put with its metadata. Only then does the Store record meta.small and
//          the blurhash; with `--stills` it also sets preview_url in the same call.
//   fallback  only when the small cannot be made for good: no processor bound, a failed probe, the configured budget
//          spent, the container refusing this row's input (one of STILL_INPUT_REFUSALS, typed by the processor from
//          the answer's status and code), verifyStill refusing its PNG, Images refusing the still as input, or a meta
//          that cannot take the still's meta.small (not a JSON object, or past MEDIA_META_BYTES with this still's
//          edges, avMetaFits: checked before anything of the small is charged or put, and by the Store). The
//          Store clears preview_url, meta.small and the blurhash, and nothing is written. A plain rebuild never
//          revisits it; `--stills` does.
//   stop   every other failure: the processor busy, unavailable, not ready, failing inside (500) or timing out (504),
//          and Images' quota or any other failure of the service, its RGBA blurhash included. The call stops at the
//          row with `retry` or `quota` before any put or Store update of the small: the row keeps its preview fields
//          and its `full`, the cursor stays before it, and units already charged stay charged. A still whose
//          container's destroy is still pending stops the call as a deadline does, keeping the lease.
//
// A row is complete (skipped, nothing read, written or charged) when `full` exists and it is audio, or a video without
// a preview (not under `--stills`), or a video whose small's metadata (one HEAD) equals its meta.small and blurhash. A
// row interrupted after `full` resumes at the small; one interrupted after the still's put adopts that small. An
// existing small that fails its checks is reported and never overwritten.
//
// Bounds: one AV row a call (MAX_AV_BUILDS_PER_CALL), within REBUILD_AV_MS; stages end at AV_COPY_MS (read, verify and
// copy), AV_PROBE_MS (the probe) and AV_STILL_MS (the still) from their start, and at the row's end. The probe runs at
// most once a call, under the rebuild's lease and the probe's one claim (domain/media-probes.ts: not again within
// PROBE_RETRY_MS of a recorded result, nor PROBE_CLAIM_MS of an unfinished claim), whatever the budgets: the probe
// clip is copied to incoming/probe-<nonce>, the StillMaker runs /still on the profile's probe object (one container per
// profile, design 4.5), its PNG goes through verifyStill and Images (stillEncodes), the copy is deleted, and the Store
// records the verdict (mastodon/media-activation.ts stillProbeVerdict, imagesVerdict) under the claim. A pass Images
// did not verify (9422) stops the call as its quota, before any charge or still. Every R2 write and delete goes through the call's `settled` (the Store confirms the lease
// first).

export const REBUILD_AV_MS = 120_000;
const AV_COPY_MS = 60_000;
const AV_PROBE_MS = 60_000;
const AV_STILL_MS = 75_000;
export const MAX_AV_BUILDS_PER_CALL = 1;
// How soon the still profile is probed again for the same build after a recorded result (design 4.15).
export { PROBE_RETRY_MS };

export type AvCall = {
  build: string;
  store: StoreStub;
  bucket: R2Bucket;
  images: ImageCodec;
  now: () => number;
  authority: ImportAuthority;
  holder: string;
  monthlyTransforms: number;
  monthlyUploads: number;
  stills: StillMaker | null;
  // `--stills`: video rows without a preview are given one.
  publish: boolean;
  // A step without a lasting effect, given up at `end` or the call's deadline, whichever is first.
  bounded: <T>(work: () => Promise<T>, end?: number) => Promise<T>;
  // An R2 write or delete, started only while the Store confirms the lease, then awaited.
  settled: <T>(start: () => Promise<T>) => Promise<T>;
};

export type AvOutcome =
  | { kind: "built" | "fallback" | "gone" }
  | { kind: "problem"; outcome: "original-missing" | "type-mismatch" | "failed"; detail?: string }
  | { kind: "refused"; code: "wrong-authority" | "rebuild-lease-lost"; message: string }
  | { kind: "budget" }
  // A transient failure (the processor busy or unavailable, Images failing or out of quota): the call stops at this
  // row, which keeps its preview fields and its written `full`, and the next call starts at it again.
  | { kind: "stop"; stopped: "retry" | "quota" };

const RETRY: AvOutcome = { kind: "stop", stopped: "retry" };
const QUOTA: AvOutcome = { kind: "stop", stopped: "quota" };

// A row that takes the fallback (fallBack).
const FALLBACK: unique symbol = Symbol("fallback");
type Fallback = typeof FALLBACK;

// What a failed still of a row's original means. Only the container's refusal of the input itself (`input`, one of
// STILL_INPUT_REFUSALS) is about the row: the fallback. An original that went is reported. Every other failure (busy,
// unavailable, readiness, an internal error or timeout of the container, a short or late answer) is the processor's
// state: the call stops and a later one makes the still. A destroy that has not finished keeps the call's lease until
// it expires, as a step given up does.
function stillFailure(made: Extract<StillOutcome, { ok: false }>): Fallback | AvOutcome {
  if (made.pending === true) {
    throw new DeadlinePassed();
  }
  if (made.input !== undefined) {
    return FALLBACK;
  }
  return made.failure === "input-missing" ? { kind: "problem", outcome: "original-missing" } : RETRY;
}

// A still's geometry and blurhash, as recorded and as the small's metadata says.
type StillFacts = Size & { blurhash: string | null };

function metadataOf(facts: StillFacts): Record<string, string> {
  return { width: String(facts.width), height: String(facts.height), blurhash: facts.blurhash ?? "" };
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Whether the row is complete as it is (see the header).
export function avComplete(av: RebuildAv, full: R2Object | null, small: R2Object | null, publish: boolean): boolean {
  if (full === null) {
    return false;
  }
  if (av.kind === "audio" || (!av.preview && !publish)) {
    return true;
  }
  if (!av.preview || small === null || av.small === null) {
    return false;
  }
  const { width, height } = av.small;
  if (!positive(width) || !positive(height)) {
    return false;
  }
  const expected = metadataOf({ width, height, blurhash: av.blurhash });
  const seen = small.customMetadata ?? {};
  return seen.width === expected.width && seen.height === expected.height && seen.blurhash === expected.blurhash;
}

export async function rebuildAv(
  call: AvCall,
  row: RebuildRow,
  av: RebuildAv,
  full: R2Object | null,
  small: R2Object | null,
): Promise<AvOutcome> {
  const end = call.now() + REBUILD_AV_MS;
  const stage = (ms: number) => Math.min(end, call.now() + ms);
  if (full === null) {
    const copied = await copyFull(call, row, av, stage(AV_COPY_MS));
    if (copied !== null) {
      return copied;
    }
  }
  if (av.kind === "audio" || (!av.preview && !call.publish)) {
    return { kind: "built" };
  }
  // A meta that cannot take even the smallest still (not an object, or no room left): the poster, nothing made.
  let facts: StillFacts | AvOutcome | Fallback;
  if (!avMetaFits(av, { width: 1, height: 1 })) {
    facts = FALLBACK;
  } else if (small !== null) {
    facts = await adopt(call, row, av, end);
  } else {
    facts = await make(call, row, av, end, stage);
  }
  if (facts === FALLBACK) {
    return fallBack(call, row, av);
  }
  if ("kind" in facts) {
    return facts;
  }
  const recorded = await call.bounded<RebuildRecord>(
    async () =>
      await call.store.recordMediaRebuildStill(call.build, {
        authority: call.authority,
        holder: call.holder,
        id: row.id,
        token: row.token,
        small: { width: facts.width, height: facts.height },
        blurhash: facts.blurhash,
        publish: !av.preview,
      }),
  );
  if (recorded.status === "denied" || recorded.status === "lease-lost") {
    return refusedBy(recorded);
  }
  // The meta changed since it was listed and cannot take this still: the poster, as when it could not before.
  if (recorded.status === "meta") {
    return fallBack(call, row, av);
  }
  return { kind: recorded.status === "gone" ? "gone" : "built" };
}

// The fallback of a video row: a row with a preview has it cleared (fallbackAvRebuild); its `full` stays.
async function fallBack(call: AvCall, row: RebuildRow, av: RebuildAv): Promise<AvOutcome> {
  if (av.preview) {
    const cleared = await call.bounded<RebuildRecord>(
      async () =>
        await call.store.fallbackMediaRebuild(call.build, {
          authority: call.authority,
          holder: call.holder,
          id: row.id,
          token: row.token,
        }),
    );
    if (cleared.status === "denied" || cleared.status === "lease-lost") {
      return refusedBy(cleared);
    }
    if (cleared.status === "gone") {
      return { kind: "gone" };
    }
  }
  return { kind: "fallback" };
}

function refusedBy(result: { status: "denied"; reason: string } | { status: "lease-lost" }): AvOutcome {
  return result.status === "denied"
    ? { kind: "refused", code: "wrong-authority", message: result.reason }
    : { kind: "refused", code: "rebuild-lease-lost", message: "the rebuild lease expired during the call" };
}

// Step 1: files/<token>/full from the original, verified in the same stream. null once written.
async function copyFull(call: AvCall, row: RebuildRow, av: RebuildAv, until: number): Promise<AvOutcome | null> {
  const original = await call.bounded(() => call.bucket.get(originalKey(row.id)), until);
  if (original === null) {
    return { kind: "problem", outcome: "original-missing" };
  }
  if (original.size > AV_OUTPUT_LIMIT) {
    await original.body.cancel();
    return { kind: "problem", outcome: "failed", detail: "too_large" };
  }
  const type = row.contentType as AvType;
  const verifier = avVerifier(type, original.size);
  let kindMismatch = false;
  // The last non-empty chunk waits for the verdict: R2 gets every byte only of a file the verifier accepted. An empty
  // chunk passes nothing and replaces nothing, so it cannot release the held one early.
  let held: Uint8Array | null = null;
  const hold = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength === 0) {
        return;
      }
      if (held !== null) {
        controller.enqueue(held);
      }
      held = chunk;
    },
    async flush(controller) {
      const verdict = await verifier.verdict;
      if (!verdict.ok) {
        throw new AvRefusal(verdict.rule);
      }
      if (verdict.facts.kind !== av.kind) {
        kindMismatch = true;
        throw new Error("kind");
      }
      if (held !== null) {
        controller.enqueue(held);
      }
    },
  });
  const aborted = new AbortController();
  const timer = setTimeout(() => aborted.abort(), Math.max(0, until - call.now()));
  const body = (original.body as ReadableStream<Uint8Array>)
    .pipeThrough(verifier.stream, { signal: aborted.signal })
    .pipeThrough(hold)
    .pipeThrough(new FixedLengthStream(original.size));
  const key = fileKey(row.token, "full");
  try {
    await call.settled(() => call.bucket.put(key, body, { httpMetadata: { contentType: type } }));
  } catch (error) {
    const late = aborted.signal.aborted;
    verifier.abort();
    const verdict = await verifier.verdict;
    if (late) {
      throw new DeadlinePassed();
    }
    if (kindMismatch) {
      return { kind: "problem", outcome: "type-mismatch", detail: `not ${av.kind}` };
    }
    if (!verdict.ok) {
      return { kind: "problem", outcome: "failed", detail: `verify:${verdict.rule}` };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    aborted.abort();
  }
  // Defence in depth, as for images: nothing deletes rows while the lease is held.
  if (
    !(await call.bounded<boolean>(
      async () => await call.store.mediaRebuildRowLive(call.build, { id: row.id, token: row.token }),
    ))
  ) {
    await call.settled(() => call.bucket.delete(key));
    return { kind: "gone" };
  }
  return null;
}

// The facts of an existing small that passes its checks, its blurhash recomputed (and the object put again with its
// metadata) when the metadata is missing or invalid.
async function adopt(
  call: AvCall,
  row: RebuildRow,
  av: RebuildAv,
  end: number,
): Promise<StillFacts | AvOutcome | Fallback> {
  const key = fileKey(row.token, "small");
  const object = await call.bounded(
    () => call.bucket.get(key, { range: { offset: 0, length: STILL_OUTPUT_LIMIT + 1 } }),
    end,
  );
  if (object === null) {
    return { kind: "problem", outcome: "failed", detail: "small-invalid" };
  }
  if (object.size > STILL_OUTPUT_LIMIT) {
    await object.body.cancel();
    return { kind: "problem", outcome: "failed", detail: "small-invalid" };
  }
  const bytes = new Uint8Array(await call.bounded(() => object.arrayBuffer(), end));
  const size = stillWebpSize(bytes);
  if (size === null) {
    return { kind: "problem", outcome: "failed", detail: "small-invalid" };
  }
  if (!avMetaFits(av, size)) {
    return FALLBACK;
  }
  const meta = object.customMetadata ?? {};
  const given = meta.blurhash;
  if (
    meta.width === String(size.width) &&
    meta.height === String(size.height) &&
    given !== undefined &&
    (given === "" || storedBlurhash(given) === given)
  ) {
    return { ...size, blurhash: given === "" ? null : given };
  }
  const charged = await call.bounded<RebuildCharge>(
    async () =>
      await call.store.chargeMediaRebuild(call.build, {
        authority: call.authority,
        holder: call.holder,
        id: row.id,
        limit: call.monthlyTransforms,
      }),
  );
  if (charged.status === "denied" || charged.status === "lease-lost") {
    return refusedBy(charged);
  }
  if (charged.status === "budget_exhausted") {
    return { kind: "budget" };
  }
  const hashed = await call.bounded(() => stillBlurhash(call.images, bytes, size, { end, now: call.now }), end);
  if (hashed.stop === "deadline") {
    throw new DeadlinePassed();
  }
  // 9422 or another failure of the RGBA output: nothing is written, so a later call computes the blurhash once Images
  // is back.
  if (hashed.stop === "quota") {
    return QUOTA;
  }
  if (hashed.stop === "failed") {
    return RETRY;
  }
  const facts = { ...size, blurhash: hashed.blurhash };
  await call.settled(() =>
    call.bucket.put(key, bytes, { httpMetadata: { contentType: "image/webp" }, customMetadata: metadataOf(facts) }),
  );
  return facts;
}

// The PNG's dimensions from its IHDR, which verifyStill has walked.

// A new small, or the fallback.
async function make(
  call: AvCall,
  row: RebuildRow,
  av: RebuildAv,
  end: number,
  stage: (ms: number) => number,
): Promise<StillFacts | AvOutcome | Fallback> {
  const stills = call.stills;
  if (stills === null) {
    return FALLBACK;
  }
  const probed = await probe(call, stills, stage);
  if (probed !== true) {
    return probed === false ? FALLBACK : probed;
  }
  const charged = await call.bounded<RebuildCharge>(
    async () =>
      await call.store.chargeMediaRebuild(call.build, {
        authority: call.authority,
        holder: call.holder,
        id: row.id,
        limit: call.monthlyTransforms,
        uploads: call.monthlyUploads,
      }),
  );
  if (charged.status === "denied" || charged.status === "lease-lost") {
    return refusedBy(charged);
  }
  if (charged.status === "budget_exhausted") {
    return FALLBACK;
  }
  const until = stage(AV_STILL_MS);
  const made = await call.bounded(() => stills.still(originalKey(row.id), until - call.now()), until);
  if (!made.ok) {
    return stillFailure(made);
  }
  if (verifyStill(made.png) !== null) {
    return FALLBACK;
  }
  // Images' output is read within STILL_OUTPUT_LIMIT and every call of it given up at the row's end.
  const preview = await call.bounded(
    () =>
      stillPreview(call.images, made.png, pngSize(made.png), { end, now: call.now }, (work) =>
        within(work, end, call.now),
      ),
    end,
  );
  if (!preview.ok) {
    // Images refusing the still as input is about this still; 9422 or any other failure of the service is not.
    return preview.reason === "unsupported" ? FALLBACK : preview.reason === "quota" ? QUOTA : RETRY;
  }
  if (preview.blurhashStop === "deadline") {
    throw new DeadlinePassed();
  }
  // The blurhash is part of the still's record: a failure of its RGBA output stops the call before the put.
  if (preview.blurhashStop === "quota") {
    return QUOTA;
  }
  if (preview.blurhashStop === "failed") {
    return RETRY;
  }
  // Held to what an adopted small is held to, so a later call can adopt what this one writes.
  const size = stillWebpSize(preview.small.bytes);
  if (size === null || size.width !== preview.small.width || size.height !== preview.small.height) {
    return RETRY;
  }
  // The row's meta must take this still's own meta.small before anything is put.
  if (!avMetaFits(av, size)) {
    return FALLBACK;
  }
  const facts = { ...size, blurhash: preview.blurhash };
  await call.settled(() =>
    call.bucket.put(fileKey(row.token, "small"), preview.small.bytes, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: metadataOf(facts),
    }),
  );
  return facts;
}

// Whether the `still@standard-1` probe has passed for this build, verified by Images. Its claim is the probe's one claim
// (claimMediaRebuildProbe): a pass that needs no probe answers at once; within the claim's cooldown the build's verdict
// stands (a failure falls back, a pass Images did not verify stops as its quota, none stops the call); otherwise the
// probe runs once and its verdict is recorded under the claim. A probe object that refused before it started a
// container (busy, its alarm's write) records nothing, so the claim holds the profile for PROBE_CLAIM_MS only.
async function probe(call: AvCall, stills: StillMaker, stage: (ms: number) => number): Promise<boolean | AvOutcome> {
  const claimed = await call.bounded<RebuildProbeClaim>(
    async () =>
      await call.store.claimMediaRebuildProbe(call.build, {
        authority: call.authority,
        holder: call.holder,
        build: call.build,
      }),
  );
  if (claimed.status === "denied" || claimed.status === "lease-lost") {
    return refusedBy(claimed);
  }
  if (claimed.status === "passed") {
    return true;
  }
  if (claimed.status === "cooldown") {
    const record = claimed.record;
    if (record === null) {
      return RETRY;
    }
    if (!record.ok) {
      return false;
    }
    return record.imagesVerified === false ? QUOTA : true;
  }
  const until = stage(AV_PROBE_MS);
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  await call.settled(() => call.bucket.put(key, stills.probeInput));
  let verdict: ProbeVerdict;
  let image: string | null = null;
  try {
    const out = await call.bounded(() => stills.probe(key, until - call.now()), until);
    image = probeImageTag(out.image);
    if (!out.ok && out.pending === true) {
      throw new DeadlinePassed();
    }
    if (!out.ok && NOT_STARTED.has(out.failure)) {
      return RETRY;
    }
    const container = stillProbeVerdict(out);
    if (container !== null || !out.ok) {
      verdict = container ?? { outcome: "no-verdict", reason: "operation" };
    } else {
      const png = out.png;
      const encoded = await call.bounded(
        () => stillEncodes(call.images, png, pngSize(png), (work) => within(work, until, call.now)),
        until,
      );
      verdict = imagesVerdict(encoded);
    }
  } finally {
    await call.settled(() => call.bucket.delete(key));
  }
  const recorded = await call.bounded(
    async () =>
      await call.store.recordMediaRebuildProbe(call.build, {
        authority: call.authority,
        holder: call.holder,
        result: {
          claim: claimed.claim,
          outcome: verdict.outcome,
          imagesVerified: verdict.outcome === "pass" && verdict.imagesVerified,
          imageTag: image,
        },
      }),
  );
  if (recorded.status === "denied" || recorded.status === "lease-lost") {
    return refusedBy(recorded);
  }
  if (recorded.status === "stale") {
    return RETRY;
  }
  if (verdict.outcome === "pass") {
    return verdict.imagesVerified ? true : QUOTA;
  }
  return verdict.outcome === "fail" ? false : RETRY;
}
