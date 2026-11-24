import {
  type ProbeAttempt,
  probeImageTag,
  type ProbeRecord,
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
  STILL_LONG_EDGE,
  STILL_OUTPUT_LIMIT,
  verifyStill,
} from "../platform/av-bytes";
import { DeadlinePassed, within } from "../platform/deadline";
import { toHex } from "../platform/hex";
import { isAnimated, MALFORMED, retainedMetadata, sniffImageType, walkWebp, webpSize } from "../platform/image-bytes";
import { type ImageCodec, type Size, stillBlurhash, stillEncodes, stillPreview } from "../platform/images";
import { fileKey, originalKey, probeInputKey } from "../platform/media-files";
import type { StillMaker, StillOutcome } from "../platform/media-transcoder";
import type { ImportAuthority } from "../platform/store-admin";
import type { StoreStub } from "../platform/store-client";
import { storedBlurhash } from "../platform/stored-bounds";

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
//          the answer's status and code), verifyStill refusing its PNG, or Images refusing the still as input. The
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
// most once a call, and after a failure for this build not again within PROBE_RETRY_MS, under the rebuild's lease and
// whatever the budgets: the probe clip is copied to
// incoming/probe-<nonce>, the StillMaker runs /still on the profile's probe object (one container per profile, design
// 4.5), its PNG goes through verifyStill and Images (stillEncodes), the copy is deleted, and the Store records the
// result for this build. Every R2 write and delete goes through the call's `settled` (the Store confirms the lease
// first).

export const REBUILD_AV_MS = 120_000;
const AV_COPY_MS = 60_000;
const AV_PROBE_MS = 60_000;
const AV_STILL_MS = 75_000;
export const MAX_AV_BUILDS_PER_CALL = 1;
const STILL_PROFILE = "still@standard-1";
// How soon a failed probe of the still profile is run again for the same build (design 4.15, PROBE_RETRY_MS).
export const PROBE_RETRY_MS = 60 * 60 * 1000;

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
  // The probe's verdict in this call, once known.
  probe: { state: "unknown" | "passed" | "failed" };
};

export type AvOutcome =
  | { kind: "built" | "fallback" | "gone"; quota?: boolean }
  | { kind: "problem"; outcome: "original-missing" | "type-mismatch" | "failed"; detail?: string }
  | { kind: "refused"; code: "wrong-authority" | "rebuild-lease-lost"; message: string }
  | { kind: "budget" }
  // A transient failure (the processor busy or unavailable, Images failing or out of quota): the call stops at this
  // row, which keeps its preview fields and its written `full`, and the next call starts at it again.
  | { kind: "stop"; stopped: "retry" | "quota" };

const RETRY: AvOutcome = { kind: "stop", stopped: "retry" };
const QUOTA: AvOutcome = { kind: "stop", stopped: "quota" };

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
    return new Fallback(`still:${made.input}`);
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

class Fallback {
  constructor(
    readonly reason: string,
    readonly quota = false,
  ) {}
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
  // A video whose still the call may record needs a meta that can hold it; otherwise nothing of the row is touched.
  if (av.kind === "video" && (av.preview || call.publish) && av.meta !== "ok") {
    return { kind: "problem", outcome: "failed", detail: `meta-${av.meta}` };
  }
  if (full === null) {
    const copied = await copyFull(call, row, av, stage(AV_COPY_MS));
    if (copied !== null) {
      return copied;
    }
  }
  if (av.kind === "audio" || (!av.preview && !call.publish)) {
    return { kind: "built" };
  }
  let facts: StillFacts | AvOutcome | Fallback;
  let quota = false;
  if (small !== null) {
    facts = await adopt(call, row, end);
  } else {
    facts = await make(call, row, end, stage);
  }
  if (facts instanceof Fallback) {
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
    return { kind: "fallback", quota: facts.quota };
  }
  if ("kind" in facts) {
    return facts;
  }
  if ("quota" in facts) {
    quota = facts.quota === true;
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
  if (recorded.status === "meta") {
    return { kind: "problem", outcome: "failed", detail: "meta-refused" };
  }
  return { kind: recorded.status === "gone" ? "gone" : "built", quota };
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
async function adopt(call: AvCall, row: RebuildRow, end: number): Promise<StillFacts | AvOutcome> {
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
  const size = smallSize(bytes);
  if (size === null) {
    return { kind: "problem", outcome: "failed", detail: "small-invalid" };
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

// The geometry of a `small` as Kopje serves one, whether adopted or just made: at most STILL_OUTPUT_LIMIT bytes, a
// still WebP that walks, with no retained metadata and edges of 1 to STILL_LONG_EDGE. null when it is not one.
function smallSize(bytes: Uint8Array): Size | null {
  const size =
    bytes.byteLength <= STILL_OUTPUT_LIMIT && sniffImageType(bytes) === "image/webp" ? webpSize(bytes) : null;
  return size === null ||
    walkWebp(bytes, () => undefined) === MALFORMED ||
    retainedMetadata(bytes, "image/webp") !== null ||
    isAnimated(bytes, "image/webp") ||
    size.width < 1 ||
    size.height < 1 ||
    Math.max(size.width, size.height) > STILL_LONG_EDGE
    ? null
    : size;
}

// The PNG's dimensions from its IHDR, which verifyStill has walked.
function pngSize(png: Uint8Array): Size {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// A new small, or the fallback.
async function make(
  call: AvCall,
  row: RebuildRow,
  end: number,
  stage: (ms: number) => number,
): Promise<StillFacts | AvOutcome | Fallback> {
  const stills = call.stills;
  if (stills === null) {
    return new Fallback("unbound");
  }
  const probed = await probe(call, stills, stage);
  if (probed !== true) {
    return probed === false ? new Fallback("probe") : probed;
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
    return new Fallback("budget");
  }
  const until = stage(AV_STILL_MS);
  const made = await call.bounded(() => stills.still(originalKey(row.id), until - call.now()), until);
  if (!made.ok) {
    return stillFailure(made);
  }
  if (verifyStill(made.png) !== null) {
    return new Fallback("still-invalid");
  }
  // Images' output is read within STILL_OUTPUT_LIMIT and every call of it given up at the row's end.
  const preview = await call.bounded(
    () =>
      stillPreview(call.images, made.png, pngSize(made.png), { end, now: call.now }, STILL_OUTPUT_LIMIT, (work) =>
        within(work, end, call.now),
      ),
    end,
  );
  if (!preview.ok) {
    // Images refusing the still as input is about this still; 9422 or any other failure of the service is not.
    return preview.reason === "unsupported" ? new Fallback("images") : preview.reason === "quota" ? QUOTA : RETRY;
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
  const size = smallSize(preview.small.bytes);
  if (size === null || size.width !== preview.small.width || size.height !== preview.small.height) {
    return RETRY;
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

// Whether the `still@standard-1` probe has passed for this build. It runs at most once a call, when no pass for this
// build is recorded and none was started for it within PROBE_RETRY_MS (at the Store's clock): the attempt is recorded
// before the probe starts, so a failing profile, and a probe that reached no verdict, cost at most one container and
// Images call an hour whatever the budgets. The profile fails only when the container refuses the packaged
// clip as input, verifyStill refuses its PNG, or Images refuses that PNG or its output fails the checks; any other
// failure of the processor or Images is no verdict, and the call stops.
async function probe(call: AvCall, stills: StillMaker, stage: (ms: number) => number): Promise<boolean | AvOutcome> {
  if (call.probe.state !== "unknown") {
    return call.probe.state === "passed";
  }
  const { record, attempt, now } = await call.bounded<{
    record: ProbeRecord | null;
    attempt: ProbeAttempt | null;
    now: number;
  }>(async () => await call.store.mediaProbeRecord(call.build, { profile: STILL_PROFILE }));
  const verdict = record !== null && record.version === call.build ? record.ok : null;
  if (verdict === true) {
    call.probe.state = "passed";
    return true;
  }
  // Started for this build within PROBE_RETRY_MS: its failure stands, and an attempt that reached no verdict (the
  // processor's or Images' state, their quota) stops the call until the hour is over.
  if (attempt !== null && attempt.version === call.build && now - attempt.at < PROBE_RETRY_MS) {
    if (verdict === false) {
      call.probe.state = "failed";
      return false;
    }
    return RETRY;
  }
  const started = await recordProbe(call, null, null);
  if (started !== null) {
    return started;
  }
  const until = stage(AV_PROBE_MS);
  const key = probeInputKey(toHex(crypto.getRandomValues(new Uint8Array(16))));
  await call.settled(() => call.bucket.put(key, stills.probeInput));
  let outcome: "passed" | "failed" | AvOutcome;
  let image: string | null = null;
  try {
    const out = await call.bounded(() => stills.probe(key, until - call.now()), until);
    image = probeImageTag(out.image);
    if (!out.ok) {
      if (out.pending === true) {
        throw new DeadlinePassed();
      }
      // The container refusing the packaged clip says the profile cannot make stills; anything else is its state.
      outcome = out.input === undefined ? RETRY : "failed";
    } else if (verifyStill(out.png) !== null) {
      outcome = "failed";
    } else {
      const png = out.png;
      const encoded = await call.bounded(
        () => stillEncodes(call.images, png, pngSize(png), (work) => within(work, until, call.now)),
        until,
      );
      outcome = encoded === "quota" ? QUOTA : encoded === "retry" ? RETRY : encoded;
    }
  } finally {
    await call.settled(() => call.bucket.delete(key));
  }
  if (typeof outcome !== "string") {
    return outcome;
  }
  const recorded = await recordProbe(call, outcome === "passed", image);
  if (recorded !== null) {
    return recorded;
  }
  call.probe.state = outcome;
  return outcome === "passed";
}

// Records the probe's start (`ok` null) or its verdict, under the lease; null once recorded.
async function recordProbe(call: AvCall, ok: boolean | null, imageTag: string | null): Promise<AvOutcome | null> {
  const recorded = await call.bounded<
    { status: "ok" } | { status: "lease-lost" } | { status: "denied"; reason: string }
  >(
    async () =>
      await call.store.recordMediaProbe(call.build, {
        authority: call.authority,
        holder: call.holder,
        profile: STILL_PROFILE,
        version: call.build,
        imageTag,
        ok,
      }),
  );
  return recorded.status === "ok" ? null : refusedBy(recorded);
}
