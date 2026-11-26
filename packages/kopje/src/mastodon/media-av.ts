import { HTTPException } from "hono/http-exception";

import { parseFocus } from "../domain/media-focus";
import {
  type ActivationInput,
  AV_UPLOAD_LIMIT,
  type AvKind,
  type Endpoint,
  PART_BYTES,
  type QueueRefusal,
  R2_CALL_MS,
  SNIFF_BYTES,
  STORE_CALL_MS,
  T_REPLY,
  type UploadText,
  V1_POLL_MS,
  V1_TIME_MS,
} from "../domain/media-processing";
import { presentMedia, processingMedia, type ThumbnailFacts } from "../domain/status-presenter";
import { sniffAvUpload } from "../platform/av-bytes";
import { readConfig } from "../platform/config";
import { DeadlinePassed } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { sniffImageType } from "../platform/image-bytes";
import { IMAGE_SIZE_LIMIT } from "../platform/images";
import { incomingKey } from "../platform/media-files";
import { MultipartRefused, MultipartStream, multipartBoundary, type PartHead } from "../platform/multipart-stream";
import { storedMediaDescription } from "../platform/stored-bounds";
import { afterResponse, type ApiContext, type ApiDeps, type ApiHandler, storeCall, userCredential } from "./context";
import { maintenanceError, mastodonError } from "./errors";
import {
  budgetRefusal,
  discard,
  EXPIRED_MESSAGE,
  FILE_BLANK,
  INVALID_TYPE,
  MEDIA_BODY_LIMIT,
  mediaProblem,
  type ProfileUpload,
  receiveImageUpload,
  RECEIVE_TOO_LONG,
  refusedForm,
  reserve,
  storeThumbnail,
  sweepSoon,
  THUMBNAIL_INVALID_TYPE,
  THUMBNAIL_TOO_LARGE,
  thumbnailFileProblem,
  TOO_LARGE,
  UNAVAILABLE,
  type Upload,
  type UploadOutcome,
  uploadParams,
} from "./media";
import { API_BODY_LIMIT, MULTIPART_PARTS, type Params, parseBody, readQuery, refusedStatus } from "./params";

// POST /api/v1/media and /api/v2/media (#1828 PR4-4): the upload route, with video and audio when they are active.
//
// With the processor bound and MEDIA_UPLOAD_MONTHLY_JOBS positive, the reservation is made with `avCandidate`; when the
// Store finds a passed probe for this build too (domain/media.ts reserveMedia answers `imagesRefusal`), uploads are
// active and the route reads the body as a stream (platform/multipart-stream.ts) up to the first `file` part's first
// SNIFF_BYTES, within MEDIA_BODY_LIMIT and the reservation's deadline, before any slot is taken. The first `file` part
// chooses the path (C2-M6): image signatures first, so AVIF stays an image (platform/image-bytes.ts), then
// sniffAvUpload. An image is refused with the 429 of the Images budget `imagesRefusal` names, or else, like a file of
// no known type and like video or audio when S1 answers `inactive`, handed to the image pipeline with every byte read
// so far replayed in front of the rest, so its reader and parser see the body as sent (Rails' last-part rule
// included). Anything else, and every request while uploads are inactive, takes the image pipeline exactly as before.
//
// Video and audio (the PR4 plan's 1.1 and 1.4, the route's side; domain/media-processing.ts names S1-S10):
//   S1 takes the staging slot (503 busy, 429 spent) and answers the staging time; the file part is streamed into
//   incoming/<id> by an R2 multipart upload of PART_BYTES parts, holding at most PART_BYTES and one read; AV_UPLOAD_LIMIT
//   + 1 bytes, a second `file` part or a `thumbnail` file part refuse it (422); the staging time cancels the reader.
//   The text fields are validated once every part is read. Every staging exit aborts the multipart upload and calls
//   S2, and deletes incoming/<id> only on its `released`.
//   S3 queues the upload with the validated text: `queued` dispatches the processor after the response; v2 answers
//   202 with nothing processed yet; v1 waits. `refused_cleanup_yours` deletes the input and answers by its reason;
//   `gone` and a reply not received deletes nothing. S1 and S3 are repeated once when no reply is received.
//   v1: S9 every V1_POLL_MS, and S10 once S9 shows an outcome or at the route's cut, arrival + V1_TIME_MS - T_REPLY
//   on the route's clock, whatever the Store's deadline_at; every wait before it (S1, the staging, S3, S9) is cut
//   there too, and the answer starts by arrival + V1_TIME_MS. The route sends S10's decision; a reply it did not
//   receive by then is answered 503 (the plan's W5). S10's `maintenance` is the maintenance 503.
// Only durations cross a clock boundary: v1Left to S1, the staging time back from it, each counted from the route's
// own reading taken before the call.

// What the route reads of activation (domain/media-processing.ts ActivationInput): undefined, and the upload route
// reserves as before #1828, without the processor's binding or with MEDIA_UPLOAD_MONTHLY_JOBS 0. Also read by the
// instance endpoints (instance.ts).
export function avUploadActivation(
  env: Env,
  deps: Pick<ApiDeps, "build" | "mediaProcessor">,
): ActivationInput | undefined {
  const config = readConfig(env);
  const budget = config.ok ? config.config.MEDIA_UPLOAD_MONTHLY_JOBS : 0;
  if (budget <= 0 || (deps.mediaProcessor?.(env) ?? null) === null) {
    return undefined;
  }
  return { binding: true, budget, build: deps.build(env) };
}

function answerOf(c: ApiContext, outcome: UploadOutcome): Response {
  return outcome.ok ? c.json(outcome.media) : mastodonError(outcome.status, outcome.error);
}

export const uploadMedia: ApiHandler = async (c, deps) => {
  // The request clock's origin, the v1 wait's arrival.
  const arrival = deps.now();
  const activation = avUploadActivation(c.env, deps);
  if (activation === undefined) {
    return receiveInactive(c, deps);
  }
  const endpoint: Endpoint = new URL(c.req.url).pathname.startsWith("/api/v1/") ? "v1" : "v2";
  // The request's cleanup, registered before the reservation is asked for.
  const cleanup = new Cleanup(c, deps);
  try {
    return await receiveCandidate(c, deps, { activation, endpoint, arrival, cleanup });
  } finally {
    cleanup.close();
  }
};

// Without the processor's binding or with MEDIA_UPLOAD_MONTHLY_JOBS 0: the upload route as before #1828.
async function receiveInactive(c: ApiContext, deps: ApiDeps): Promise<Response> {
  const reserved = await reserve(c, deps, () => userCredential(c, deps));
  if (!reserved.ok) {
    cancelBody(c.req.raw);
    return mastodonError(reserved.status, reserved.error);
  }
  return answerOf(c, await receiveImageUpload(c, deps, reserved.upload, c.req.raw));
}

// With the binding and a budget: the reservation as an AV candidate. On v1 it is cut at the route's cut, as every
// wait before S10 is (one clock per request); a reservation answering later is abandoned when it does.
// On v2 it waits as the image path's does: a v2 image's answer does not depend on the probe.
async function receiveCandidate(
  c: ApiContext,
  deps: ApiDeps,
  r: { activation: ActivationInput; endpoint: Endpoint; arrival: number; cleanup: Cleanup },
): Promise<Response> {
  const cut = r.endpoint === "v1" ? r.arrival + V1_TIME_MS - T_REPLY : Infinity;
  const giveUp = r.endpoint === "v1" ? r.arrival + V1_TIME_MS : Infinity;
  const reserving = reserve(c, deps, () => userCredential(c, deps), { avCandidate: { build: r.activation.build } });
  const reserved = await by(deps, () => reserving, cut);
  if (reserved === CUT) {
    r.cleanup.late(reserving, STORE_CALL_MS, (late) => {
      if (late.ok) {
        r.cleanup.discard(late.upload);
      }
    });
    cancelBody(c.req.raw);
    return mastodonError(503, RECEIVE_TOO_LONG);
  }
  if (!reserved.ok) {
    cancelBody(c.req.raw);
    return mastodonError(reserved.status, reserved.error);
  }
  const { upload } = reserved;
  if (upload.imagesRefusal === undefined) {
    return answerOf(c, await receiveImageUpload(c, deps, upload, c.req.raw));
  }
  return receiveActive(c, deps, { ...r, upload, cut, giveUp });
}

// A body no longer read: cancelled, not awaited (a cancel that never settles holds nothing up).
function cancelBody(request: Request): void {
  request.body?.cancel().catch(() => {});
}

// ---- Messages (design 4.7, 4.11, 4.14)

const BUSY = "Media processing is busy. Try again in a moment.";
const PROCESS_TOO_LONG = "Media processing took too long. Try a shorter file.";
const AV_TOO_LARGE = "Validation failed: File file size must be less than 90 MB";
const OUTSIDE_ENVELOPE = "Validation failed: File is too long or too large to process";
const PROCESSING_ERROR = "Error processing thumbnail for uploaded media";
// A second `file` part after a video or audio one (Mastodon reads the last: docs/mastodon-deviations.md).
const REPEATED_FILE = "Validation failed: File was sent more than once";
// A second `thumbnail` part of a video or audio upload (#1828 PR6 D-9; Mastodon reads the last).
const REPEATED_THUMBNAIL = "Validation failed: Thumbnail was sent more than once";

// The ceiling on the bytes pulled before the file part once a `thumbnail` file part comes before it (#1828 PR6,
// "Multipart"): room for a thumbnail past IMAGE_SIZE_LIMIT (judged after the sniff), the text parts' API_BODY_LIMIT
// and the sniff. Without such a part the ceiling stays MEDIA_BODY_LIMIT, as the image pipeline's body.
export const PREFIX_THUMBNAIL_LIMIT = MEDIA_BODY_LIMIT + API_BODY_LIMIT + SNIFF_BYTES;

// ---- Timing

// The request on the active path: v1's route cut (arrival + V1_TIME_MS - T_REPLY), which cuts every wait before
// S10, and its give-up (arrival + V1_TIME_MS), which cuts S10 and the answer; both Infinity on v2.
type Active = {
  upload: Upload;
  activation: ActivationInput;
  endpoint: Endpoint;
  arrival: number;
  cut: number;
  giveUp: number;
  cleanup: Cleanup;
};

const CUT: unique symbol = Symbol("cut");
const UNKNOWN: unique symbol = Symbol("unknown");

// A wait of `ms` on the route's clock (deps.wait, else a timer), cancelled with `signal`.
function timer(deps: ApiDeps, ms: number, signal: AbortSignal): Promise<void> {
  if (deps.wait !== undefined) {
    return deps.wait(ms, signal);
  }
  return new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(id));
  });
}

// `start` raced against `end` on the route's clock: its value, or CUT when the cut comes first. Nothing is started at
// or past `end` (the spec's RouteWrite: no write after its cut); the timer is cleared once the race settles. A value
// received before the cut's timer fires is the answer, whatever the clock reads by then (D45).
async function by<T>(deps: ApiDeps, start: () => Promise<T>, end: number): Promise<T | typeof CUT> {
  if (end !== Infinity && end - deps.now() <= 0) {
    return CUT;
  }
  const work = start();
  work.catch(() => {});
  if (end === Infinity) {
    return work;
  }
  const stop = new AbortController();
  try {
    return await Promise.race([work, timer(deps, end - deps.now(), stop.signal).then((): typeof CUT => CUT)]);
  } finally {
    stop.abort();
  }
}

type Failed = (fields: Record<string, unknown>) => void;

// A cleanup call awaited at most `ms` from now (R2_CALL_MS, STORE_CALL_MS): its value, or CUT when it fails or does
// not answer by then, logged by `failed` and left to the bounds that reclaim it (the sweep, the orphan pass, R2's
// lifecycle rule). With `strict`, a value received past the deadline before its timer fired is CUT too: the deadline is
// the route's clock, whichever settles first, for a reply whose value the cleanup acts on (S2's `released`).
async function bounded<T>(
  deps: ApiDeps,
  call: () => Promise<T>,
  ms: number,
  failed: Failed,
  strict = false,
): Promise<T | typeof CUT> {
  const end = deps.now() + ms;
  try {
    const value = await by(deps, call, end);
    if (value === CUT || (strict && deps.now() > end)) {
      failed({ timedOut: true });
      return CUT;
    }
    return value;
  } catch (error) {
    failed(errorFields(error));
    return CUT;
  }
}

// The request's cleanup: one background task, registered with waitUntil before the reservation is asked for, so it
// runs while the invocation lives whatever the client does, and the answer never waits for it. Its units run in turn,
// each call awaited at most its bound (R2_CALL_MS for R2, STORE_CALL_MS for the Store); it ends once the route is done
// (`close`), every unit has run and every value it waits for has arrived or passed its bound.
class Cleanup {
  readonly #c: ApiContext;
  readonly #deps: ApiDeps;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #holds = new Set<Promise<unknown>>();
  readonly #closed = Promise.withResolvers<void>();

  constructor(c: ApiContext, deps: ApiDeps) {
    this.#c = c;
    this.#deps = deps;
    afterResponse(c, this.#drain());
  }

  // `unit` after the units before it; its calls go through `bounded`, so it ends within their bounds.
  add(unit: () => Promise<unknown>): void {
    this.#chain = this.#chain.then(unit);
  }

  // One call as a unit, awaited at most `ms`.
  step(ms: number, call: () => Promise<unknown>, failed: Failed): void {
    this.add(() => bounded(this.#deps, call, ms, failed));
  }

  // Work left running past the answer (v1's flow after its give-up): the task ends once it settles.
  hold(work: Promise<unknown>): void {
    const held: Promise<unknown> = work.catch(() => {}).finally(() => this.#holds.delete(held));
    this.#holds.add(held);
  }

  // A value that arrives after its cut (a reservation, a multipart upload's handle), released when it arrives within
  // `ms`; past that it is left to the bounds that reclaim it.
  late<T>(work: Promise<T>, ms: number, release: (value: T) => void): void {
    this.hold(
      by(this.#deps, () => work, this.#deps.now() + ms).then((value) => {
        if (value !== CUT) {
          release(value);
        }
      }),
    );
  }

  // A reservation the route releases before staging anything: abandoned (domain/media.ts abandonMedia, then its
  // keys' delete, media.ts discard), awaited at most STORE_CALL_MS + R2_CALL_MS in all.
  discard(upload: Upload): void {
    this.step(
      STORE_CALL_MS + R2_CALL_MS,
      () => discard(this.#c, this.#deps, upload, "keep"),
      (fields) => console.warn({ event: "kopje.media.upload.abandon_failed", ...fields }),
    );
  }

  // A thumbnail the request made (#1828 PR6) and no S3 linked: doomed unless linked (media.ts discard, `doom`; a linked
  // one is no upload of the owner's, so nothing happens to it), then the sweep after the response deletes its keys.
  // Added only once the making has settled, so it never races the making's own writes.
  discardThumbnail(child: ProfileUpload): void {
    this.step(
      2 * STORE_CALL_MS + R2_CALL_MS,
      async () => {
        await discard(this.#c, this.#deps, child);
        sweepSoon(this.#c, this.#deps);
      },
      (fields) => console.warn({ event: "kopje.media.upload.abandon_failed", ...fields }),
    );
  }

  close(): void {
    this.#closed.resolve();
  }

  async #drain(): Promise<void> {
    await this.#closed.promise;
    for (;;) {
      const chain = this.#chain;
      await Promise.all([chain, ...this.#holds]);
      if (chain === this.#chain && this.#holds.size === 0) {
        return;
      }
    }
  }
}

// A Store call whose reply may not be received (thrown, or the RPC lost): UNKNOWN then. An HTTP answer of the Store's
// (an authorization refusal) passes on.
async function reply<T>(call: () => Promise<T>): Promise<T | typeof UNKNOWN> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    console.warn({ event: "kopje.media.upload.reply_lost", ...errorFields(error) });
    return UNKNOWN;
  }
}

// A call repeated once when its reply is not received (S1, S3: each idempotent for the reservation, 1.4), each
// attempt cut at v1's cut, or on v2 at STORE_CALL_MS from the attempt, where a cut is a reply not received and not
// repeated (UNKNOWN on v2, CUT on v1, which then asks S10).
async function repeatedOnce<T>(
  deps: ApiDeps,
  call: () => Promise<T>,
  endpoint: Endpoint,
  cut: number,
): Promise<T | typeof UNKNOWN | typeof CUT> {
  const attempt = () => by(deps, () => reply(call), endpoint === "v1" ? cut : deps.now() + STORE_CALL_MS);
  const first = await attempt();
  const answer = first === UNKNOWN ? await attempt() : first;
  return answer === CUT && endpoint === "v2" ? UNKNOWN : answer;
}

class Cut extends Error {}

// `start` raced against `end` (by), a cut thrown as Cut.
async function before<T>(deps: ApiDeps, start: () => Promise<T>, end: number): Promise<T> {
  const settled = await by(deps, start, end);
  if (settled === CUT) {
    throw new Cut();
  }
  return settled;
}

// A reader guard that rejects each pull still waiting at `end` (Cut).
function cutGuard(deps: ApiDeps, end: number) {
  return <T>(read: Promise<T>): Promise<T> => before(deps, () => read, end);
}

// ---- The sniff

type Text = { head: PartHead; body: Uint8Array };

// The first `file` part's head and first SNIFF_BYTES, after the parts before it (kept, as text); null when the body has
// no such part (or more parts than Rack takes), and the image pipeline answers it.
async function firstFile(
  reader: MultipartStream,
): Promise<{ prefix: Uint8Array; texts: Text[]; file: PartHead } | null> {
  const texts: Text[] = [];
  for (;;) {
    const head = await reader.next();
    if (head === null || texts.length >= MULTIPART_PARTS) {
      return null;
    }
    if (head.name === "file" && head.file) {
      return { prefix: await reader.peek(SNIFF_BYTES), texts, file: head };
    }
    // The reader's ceiling (MEDIA_BODY_LIMIT, or PREFIX_THUMBNAIL_LIMIT once a thumbnail file is sent) bounds these
    // parts. Nothing is refused here: the file's kind decides how they are judged (AvUpload #beforeSlot, or the image
    // pipeline the body is replayed to).
    if (head.name === "thumbnail" && head.file) {
      reader.limit = Math.max(reader.limit, PREFIX_THUMBNAIL_LIMIT);
    }
    texts.push({ head, body: await collected(reader) });
  }
}

// The current part's body, within `limit` bytes when given (`refusal` past it, by default 413).
async function collected(
  reader: MultipartStream,
  limit = Infinity,
  refusal = () => new StagingRefusal(413, "Request body is too large"),
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await reader.body((chunk) => {
    size += chunk.byteLength;
    if (size > limit) {
      throw refusal();
    }
    chunks.push(chunk.slice());
  });
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

// The bytes of a part as sent (its head and body) and of its delimiter: what the text parts weigh against
// API_BODY_LIMIT, the bound of any form's text (params.ts readParams).
function weight(text: Text): number {
  return text.head.bytes.byteLength + text.body.byteLength + 4 + 80;
}

// The request with its body replayed from what `reader` read, for the image pipeline.
function replayed(request: Request, reader: MultipartStream): Request {
  return new Request(request.url, { method: request.method, headers: request.headers, body: reader.replay() });
}

async function receiveActive(c: ApiContext, deps: ApiDeps, a: Active): Promise<Response> {
  const request = c.req.raw;
  const today = async (from: Request) => answerOf(c, await receiveImageUpload(c, deps, a.upload, from));
  // A Content-Type outside the canonical form takes the whole-body path, as before #1828 (multipartBoundary).
  const boundary = multipartBoundary(request.headers.get("content-type") ?? "");
  if (boundary === null || request.body === null) {
    return today(request);
  }
  // The prefix: bounded by MEDIA_BODY_LIMIT and the reservation's deadline, as the image pipeline's whole body is, and
  // on v1 by the route's cut, which answers as a held staging does.
  const end = Math.min(a.upload.deadline, a.cut);
  const reader = new MultipartStream(
    request.body as ReadableStream<Uint8Array>,
    boundary.boundary,
    MEDIA_BODY_LIMIT,
    cutGuard(deps, end),
  );
  let found: Awaited<ReturnType<typeof firstFile>>;
  try {
    found = await firstFile(reader);
  } catch (error) {
    if (error instanceof Cut || (error instanceof MultipartRefused && error.reason === "limit")) {
      await reader.cancel();
      a.cleanup.discard(a.upload);
      if (error instanceof Cut && end === a.cut) {
        return mastodonError(503, RECEIVE_TOO_LONG);
      }
      return mastodonError(422, error instanceof Cut ? EXPIRED_MESSAGE : TOO_LARGE);
    }
    if (error instanceof MultipartRefused) {
      return today(replayed(request, reader));
    }
    await reader.cancel();
    a.cleanup.discard(a.upload);
    throw error;
  }
  if (found === null) {
    return today(replayed(request, reader));
  }
  if (sniffImageType(found.prefix) !== null) {
    if (a.upload.imagesRefusal === null || a.upload.imagesRefusal === undefined) {
      return today(replayed(request, reader));
    }
    // Q1: the attempt was counted; the image is refused before Images is asked, its reservation abandoned.
    await reader.cancel();
    a.cleanup.discard(a.upload);
    const refused = budgetRefusal(a.upload.imagesRefusal);
    return mastodonError(refused.status, refused.error);
  }
  const kind = sniffAvUpload(found.prefix);
  if (kind === null) {
    return today(replayed(request, reader));
  }
  const av = new AvUpload(c, deps, a, reader, kind, { ...found, boundary });
  if (a.endpoint === "v2") {
    return av.run(today);
  }
  return av.v1(today);
}

// ---- Video and audio

// A refusal while the body is read: its answer.
class StagingRefusal extends Error {
  constructor(
    readonly status: number,
    readonly answer: string,
  ) {
    super(answer);
  }
}

// S3's refusal, its input deleted (design 4.14): the budget's 429, today's type refusal for a probe verdict revoked
// meanwhile (design 4.14, "Not active"), else 503; a thumbnail no longer linkable (#1828 PR6, made invalid between its
// making and S3) is a transient failure the client may send again.
function queueRefusal(reason: QueueRefusal): Response {
  switch (reason) {
    case "spent":
      return mastodonError(429, budgetRefusal("instance").error);
    case "inactive":
      return mastodonError(422, INVALID_TYPE);
    case "time":
    case "staging_deadline":
      return mastodonError(503, RECEIVE_TOO_LONG);
    case "restored":
    case "thumbnail":
      return mastodonError(503, UNAVAILABLE);
  }
}

class AvUpload {
  readonly #c: ApiContext;
  readonly #deps: ApiDeps;
  readonly #a: Active;
  readonly #reader: MultipartStream;
  readonly #kind: AvKind;
  // The parts other than the streamed file, in order: the texts before it, then the parts after it (a file part with
  // its body dropped: once weighed, or, the thumbnail's, once kept in #thumbnail).
  readonly #texts: Text[];
  // The one `thumbnail` file part's body (#1828 PR6, D-9), made into the upload's thumbnail after the staging.
  #thumbnail: Uint8Array | null = null;
  // The streamed file's head and its place among #texts, for #params' zero-byte placeholder.
  readonly #file: { head: PartHead; at: number };
  // The body's multipart boundary, as the reader read it, and whether the header quoted it.
  readonly #boundary: { boundary: string; quoted: boolean };
  // The route's cut (v1: arrival + V1_TIME_MS - T_REPLY; v2: none) and its give-up (v1: arrival + V1_TIME_MS).
  readonly #cut: number;
  readonly #giveUp: number;
  // Set once the v1 route answered at its give-up: no Store call is started after it but the staging's cleanup.
  #answered = false;
  constructor(
    c: ApiContext,
    deps: ApiDeps,
    a: Active,
    reader: MultipartStream,
    kind: AvKind,
    found: { texts: Text[]; file: PartHead; boundary: { boundary: string; quoted: boolean } },
  ) {
    this.#c = c;
    this.#deps = deps;
    this.#a = a;
    this.#reader = reader;
    this.#kind = kind;
    this.#texts = found.texts;
    this.#file = { head: found.file, at: found.texts.length };
    this.#boundary = found.boundary;
    this.#cut = a.cut;
    this.#giveUp = a.giveUp;
  }

  get #id(): string {
    return this.#a.upload.id;
  }

  get #token(): string {
    return this.#a.upload.token;
  }

  // v1: the upload's answer, or 503 at arrival + V1_TIME_MS when it has none by then. A reply received before the
  // give-up fires is the answer (D45): nothing between S10's reply and the answer waits on I/O, so the answer settles
  // in the same turn, before the give-up's timer can fire. Work still running goes on after the response, and starts
  // no Store call but the staging's cleanup.
  async v1(today: (from: Request) => Promise<Response>): Promise<Response> {
    const flow = this.run(today);
    flow.catch(() => {});
    const first = await by(this.#deps, () => flow, this.#giveUp);
    if (first !== CUT) {
      return first;
    }
    this.#answered = true;
    this.#a.cleanup.hold(
      flow.catch((error: unknown) => {
        console.error({ event: "kopje.media.upload.failed", ...errorFields(error) });
      }),
    );
    return mastodonError(503, PROCESS_TOO_LONG);
  }

  async run(today: (from: Request) => Promise<Response>): Promise<Response> {
    // The query first, as Rack reads it before the body and the image path refuses it before the file.
    const query = readQuery(this.#c.req.raw);
    if (!query.ok) {
      return this.#refuseBeforeSlot(new StagingRefusal(query.status, refusedForm(query.status).error));
    }
    const refused = this.#beforeSlot();
    if (refused !== null) {
      return this.#refuseBeforeSlot(refused);
    }
    const readBefore = this.#deps.now();
    const v1Left = this.#a.endpoint === "v1" ? V1_TIME_MS - (readBefore - this.#a.arrival) : null;
    const taken = await repeatedOnce(
      this.#deps,
      () =>
        storeCall(this.#c, this.#deps, (s, b) =>
          s.takeAvSlot(b, {
            id: this.#id,
            token: this.#token,
            kind: this.#kind,
            v1Left,
            activation: this.#a.activation,
          }),
        ),
      this.#a.endpoint,
      this.#cut,
    );
    if (taken === CUT) {
      await this.#reader.cancel();
      return this.#decide();
    }
    if (taken !== UNKNOWN && taken.status === "inactive") {
      // The probe's verdict went between the reservation and S1: the image pipeline answers, as for any type it
      // refuses.
      return today(replayed(this.#c.req.raw, this.#reader));
    }
    if (taken === UNKNOWN || taken.status !== "taken") {
      await this.#reader.cancel();
      if (taken !== UNKNOWN && taken.status === "maintenance") {
        return maintenanceError();
      }
      this.#abandon();
      return this.#slotRefusal(taken === UNKNOWN ? "unknown" : taken.status);
    }
    this.#reader.forget();
    const end = Math.min(readBefore + taken.stagingMs, this.#cut);
    const staged = await this.#stage(end, query.params);
    if ("refusal" in staged) {
      return this.#exit(taken.stagedAt, staged.refusal);
    }
    const thumbnail = this.#thumbnail;
    this.#thumbnail = null;
    if (thumbnail === null) {
      return this.#queue(taken.stagedAt, staged, null);
    }
    const made = await this.#make(taken.stagedAt, thumbnail, end);
    if ("refusal" in made) {
      return this.#exit(taken.stagedAt, made.refusal);
    }
    return this.#queue(taken.stagedAt, staged, made.child);
  }

  // The thumbnail made from `bytes` after the staging and before S3 (#1828 PR6, "POST timing"), by `end`: the staging
  // time S1 answered and v1's cut. The making is awaited no later than `end`: at `end`, or on its failure, the staging
  // exits at once (S2 depends on nothing the making holds), and a thumbnail still being made is discarded by the
  // request's cleanup once the making settles, after its own writes (storeThumbnail discards one it failed itself).
  async #make(
    stagedAt: number,
    bytes: Uint8Array,
    end: number,
  ): Promise<{ child: ProfileUpload } | { refusal: StagingRefusal }> {
    const making = storeThumbnail(this.#c, this.#deps, () => this.#a.upload.credential(), bytes, {
      end,
      parent: { id: this.#id, token: this.#token, stagedAt },
    });
    making.catch(() => {});
    let made: Awaited<typeof making> | typeof CUT;
    try {
      made = await by(this.#deps, () => making, end);
    } catch (error) {
      if (error instanceof HTTPException) {
        this.#release(stagedAt);
        throw error;
      }
      if (!(error instanceof DeadlinePassed)) {
        console.error({ event: "kopje.media.upload.thumbnail_failed", ...errorFields(error) });
      }
      return {
        refusal: new StagingRefusal(503, error instanceof DeadlinePassed ? RECEIVE_TOO_LONG : UNAVAILABLE),
      };
    }
    if (made === CUT) {
      this.#a.cleanup.hold(
        making.then((late) => {
          if (late.ok) {
            this.#a.cleanup.discardThumbnail(late.upload);
          }
        }),
      );
      return { refusal: new StagingRefusal(503, RECEIVE_TOO_LONG) };
    }
    return made.ok ? { child: made.upload } : { refusal: new StagingRefusal(made.status, made.error) };
  }

  // A refusal before any slot is taken: the body cancelled and the reservation abandoned.
  async #refuseBeforeSlot(refused: StagingRefusal): Promise<Response> {
    await this.#reader.cancel();
    this.#abandon();
    return mastodonError(refused.status, refused.answer);
  }

  // The refusals the parts before the file part decide, before any slot is taken (P7), now that the file is known to be
  // video or audio (#1828 PR6, "Multipart"): one `thumbnail` part (D-9), not text (D-3: empty text is none), and a file
  // within IMAGE_SIZE_LIMIT and of an image type by its signature, whose body is then kept apart and weighs nothing.
  #beforeSlot(): StagingRefusal | null {
    if (this.#texts.some((t) => t.head.name === "file")) {
      return new StagingRefusal(422, REPEATED_FILE);
    }
    const thumbnails = this.#texts.filter((t) => t.head.name === "thumbnail");
    if (thumbnails.length > 1) {
      return new StagingRefusal(422, REPEATED_THUMBNAIL);
    }
    const [thumbnail] = thumbnails;
    if (thumbnail !== undefined && !thumbnail.head.file && thumbnail.body.byteLength > 0) {
      return new StagingRefusal(422, THUMBNAIL_INVALID_TYPE);
    }
    if (thumbnail?.head.file === true) {
      const problem = thumbnailFileProblem(thumbnail.body.byteLength, thumbnail.body);
      if (problem !== undefined) {
        return new StagingRefusal(422, problem);
      }
      this.#thumbnail = thumbnail.body;
      thumbnail.body = new Uint8Array();
    }
    if (this.#texts.reduce((sum, t) => sum + weight(t), 0) > API_BODY_LIMIT) {
      return new StagingRefusal(413, "Request body is too large");
    }
    return null;
  }

  #slotRefusal(status: "gone" | "time" | "busy" | "spent" | "unknown"): Response {
    switch (status) {
      case "busy":
        return mastodonError(503, BUSY);
      case "spent":
        return mastodonError(429, budgetRefusal("instance").error);
      case "time":
        return mastodonError(503, RECEIVE_TOO_LONG);
      case "gone":
      case "unknown":
        return mastodonError(503, UNAVAILABLE);
    }
  }

  // The file part into incoming/<id>, then the parts after it, all before `end` on the route's clock (the staging
  // time S1 answered, and v1's cut): the input's size and the validated text, or the refusal that ends the staging.
  async #stage(end: number, query: Params): Promise<{ bytes: number; params: Params } | { refusal: StagingRefusal }> {
    const deps = this.#deps;
    this.#reader.limit = Number.MAX_SAFE_INTEGER;
    this.#reader.guard = cutGuard(deps, end);
    // Each R2 call is started only before `end`.
    const write = <T>(call: () => Promise<T>): Promise<T> => before(deps, call, end);
    let upload: R2MultipartUpload | null = null;
    try {
      if (deps.now() >= end) {
        throw new Cut();
      }
      // A create answering after the cut is aborted when it answers, by the request's cleanup; one that never reaches a
      // live Worker is left to R2's lifecycle rule (W8).
      const creating = this.#c.env.MEDIA.createMultipartUpload(incomingKey(this.#id));
      const created = await by(deps, () => creating, end);
      if (created === CUT) {
        this.#a.cleanup.late(creating, R2_CALL_MS, (late) => this.#abortUpload(late));
        throw new Cut();
      }
      upload = created;
      const multipart = upload;
      const parts: R2UploadedPart[] = [];
      // One part's buffer, allocated when a byte is to go in and released once sent.
      let buffer: Uint8Array | null = null;
      let fill = 0;
      let bytes = 0;
      const flush = async () => {
        const part = (buffer ?? new Uint8Array()).subarray(0, fill);
        buffer = null;
        fill = 0;
        parts.push(await write(() => multipart.uploadPart(parts.length + 1, part)));
      };
      await this.#reader.body(async (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > AV_UPLOAD_LIMIT) {
          throw new StagingRefusal(422, AV_TOO_LARGE);
        }
        for (let at = 0; at < chunk.byteLength;) {
          buffer ??= new Uint8Array(PART_BYTES);
          const n = Math.min(PART_BYTES - fill, chunk.byteLength - at);
          buffer.set(chunk.subarray(at, at + n), fill);
          fill += n;
          at += n;
          if (fill === PART_BYTES) {
            await flush();
          }
        }
      });
      // The file's last part is sent, and its buffer released, before the next part's head is read (#1828 PR6), so a
      // trailing thumbnail is never held beside a part buffer.
      if (fill > 0) {
        await flush();
      }
      let weighed = this.#texts.reduce((sum, t) => sum + weight(t), 0);
      for (;;) {
        const head = await this.#reader.next();
        if (head === null) {
          break;
        }
        if (head.name === "file") {
          throw new StagingRefusal(422, REPEATED_FILE);
        }
        // D-9: a second thumbnail is refused at its head, none of its bytes read; one file is kept within
        // IMAGE_SIZE_LIMIT, its head weighed and its body not.
        if (head.name === "thumbnail" && this.#texts.some((t) => t.head.name === "thumbnail")) {
          throw new StagingRefusal(422, REPEATED_THUMBNAIL);
        }
        const thumbnail = head.name === "thumbnail" && head.file;
        const body = thumbnail
          ? await collected(this.#reader, IMAGE_SIZE_LIMIT, () => new StagingRefusal(422, THUMBNAIL_TOO_LARGE))
          : await collected(this.#reader, API_BODY_LIMIT);
        weighed += weight({ head, body: thumbnail ? new Uint8Array() : body });
        if (weighed > API_BODY_LIMIT || this.#texts.length >= MULTIPART_PARTS) {
          throw new StagingRefusal(413, "Request body is too large");
        }
        if (thumbnail) {
          this.#thumbnail = body;
        }
        // A file part's bytes, past the weight's bound (RES-1), are not kept here: #params reads it as a zero-byte file.
        this.#texts.push(head.file ? { head, body: new Uint8Array() } : { head, body });
      }
      await this.#reader.cancel();
      const params = await this.#params(query);
      if ("error" in params) {
        throw new StagingRefusal(params.status ?? 422, params.error);
      }
      // A thumbnail file after the file is judged once the form is (the description first, as the image path orders
      // them); one before it was judged before the slot.
      const problem =
        this.#thumbnail === null ? undefined : thumbnailFileProblem(this.#thumbnail.byteLength, this.#thumbnail);
      if (problem !== undefined) {
        throw new StagingRefusal(422, problem);
      }
      await write(() => multipart.complete(parts));
      upload = null;
      return { bytes, params };
    } catch (error) {
      await this.#reader.cancel();
      if (upload !== null) {
        this.#abortUpload(upload);
      }
      if (error instanceof StagingRefusal) {
        return { refusal: error };
      }
      if (error instanceof Cut) {
        return { refusal: new StagingRefusal(503, RECEIVE_TOO_LONG) };
      }
      if (error instanceof MultipartRefused) {
        return { refusal: new StagingRefusal(422, FILE_BLANK) };
      }
      console.error({ event: "kopje.media.upload.staging_failed", ...errorFields(error) });
      return { refusal: new StagingRefusal(503, UNAVAILABLE) };
    }
  }

  // The parts as the image pipeline reads a form (its parser, the query merged and the form's bounds): the parts in the
  // order sent, each file part (the streamed file included) as a zero-byte file under its own head, parsed again by the
  // runtime's form parser, so the names' shapes (`file` then `file[]`: 400) and the description and thumbnail rules
  // (mediaProblem) are judged as on the image path.
  async #params(query: Params): Promise<Params | { error: string; status?: 400 | 413 }> {
    const { boundary, quoted } = this.#boundary;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const empty = new Uint8Array();
    const parts = this.#texts.toSpliced(this.#file.at, 0, { head: this.#file.head, body: empty });
    for (const text of parts) {
      chunks.push(encoder.encode(`--${boundary}\r\n`), text.head.bytes, encoder.encode("\r\n\r\n"), text.body);
      chunks.push(encoder.encode("\r\n"));
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));
    const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    let form: Params;
    try {
      // The header as sent, rebuilt: the canonical form needs no escape inside the quotes.
      form = await parseBody(`multipart/form-data; boundary=${quoted ? `"${boundary}"` : boundary}`, body, {
        names: ["file", "thumbnail"],
        maxBytes: 0,
      });
    } catch (error) {
      const status = refusedStatus(error);
      return status === undefined ? { error: FILE_BLANK } : { error: "Malformed request body", status };
    }
    const params = uploadParams(query, form);
    if ("error" in params) {
      return params;
    }
    const problem = mediaProblem(params, params.get("description"), true);
    return problem === undefined ? params : { error: problem };
  }

  // A staging exit (P7, the staging time): the refusal's answer at once; after it, in the request's cleanup and in this
  // order, S2 awaited at most STORE_CALL_MS, the input deleted only on a `released` received within it (an authorized
  // delete before the abandonment, so a held abandonment cannot hold it up), and the reservation abandoned.
  #exit(stagedAt: number, refusal: StagingRefusal): Response {
    this.#release(stagedAt);
    return mastodonError(refusal.status, refusal.answer);
  }

  // A staging exit's cleanup (#exit), for an answer given otherwise too (an HTTP answer of the Store's, passed on).
  #release(stagedAt: number): void {
    this.#a.cleanup.add(async () => {
      const released = await bounded(
        this.#deps,
        () =>
          storeCall(this.#c, this.#deps, (s, b) => s.releaseStaging(b, { id: this.#id, token: this.#token, stagedAt })),
        STORE_CALL_MS,
        (fields) => console.warn({ event: "kopje.media.upload.release_failed", ...fields }),
        true,
      );
      if (released !== CUT && released.status === "released") {
        await this.#inputDelete(true);
      }
    });
    this.#abandon();
  }

  // S3 with the validated text and the thumbnail `child` the request made, if any, which S3 links in its own
  // transaction (#1828 PR6, "POST link"): a committed S3 has it, whatever becomes of the reply. On every other outcome,
  // a final unknown included, the child is discarded (a no-op for a child S3 linked).
  async #queue(
    stagedAt: number,
    staged: { bytes: number; params: Params },
    child: ProfileUpload | null,
  ): Promise<Response> {
    const answer = await this.#queued(stagedAt, staged, child);
    if (child !== null && !answer.kept) {
      this.#a.cleanup.discardThumbnail(child);
    }
    return answer.response;
  }

  async #queued(
    stagedAt: number,
    staged: { bytes: number; params: Params },
    child: ProfileUpload | null,
  ): Promise<{ response: Response | Promise<Response>; kept: boolean }> {
    if (this.#answered) {
      return { response: mastodonError(503, PROCESS_TOO_LONG), kept: false };
    }
    const text: UploadText = {
      description: staged.params.get("description") ?? "",
      focus: parseFocus(staged.params.get("focus")),
    };
    const queued = await repeatedOnce(
      this.#deps,
      () =>
        storeCall(this.#c, this.#deps, (s, b) =>
          s.queueNormalize(b, {
            id: this.#id,
            token: this.#token,
            stagedAt,
            bytes: staged.bytes,
            text,
            activation: this.#a.activation,
            ...(child === null ? {} : { thumbnail: { id: child.id, token: child.token } }),
          }),
        ),
      this.#a.endpoint,
      this.#cut,
    );
    if (queued === CUT) {
      return { response: this.#decide(), kept: false };
    }
    if (queued === UNKNOWN) {
      return { response: mastodonError(503, UNAVAILABLE), kept: false };
    }
    switch (queued.status) {
      case "queued":
        this.#dispatch(queued.teardownId);
        return {
          response: this.#a.endpoint === "v2" ? this.#accepted(text, queued.thumbnail) : this.#wait(),
          kept: true,
        };
      case "settled":
        return {
          response: this.#a.endpoint === "v2" ? this.#settled(text, queued.thumbnail) : this.#wait(),
          kept: true,
        };
      case "refused_cleanup_yours":
        this.#deleteInput();
        this.#abandon();
        return { response: queueRefusal(queued.reason), kept: false };
      case "maintenance":
        return { response: maintenanceError(), kept: false };
      case "gone":
        return { response: mastodonError(503, UNAVAILABLE), kept: false };
    }
  }

  // The processor's run after the response (S12 repairs a lost one).
  #dispatch(teardownId: string): void {
    const processor = this.#deps.mediaProcessor?.(this.#c.env) ?? null;
    if (processor === null) {
      return;
    }
    afterResponse(
      this.#c,
      processor.uploads.run(this.#id, this.#token, teardownId).catch((error: unknown) => {
        console.warn({ event: "kopje.media.upload.run_failed", ...errorFields(error) });
      }),
    );
  }

  // v2's 202 for a repeat S3 found already queued (the spec's RouteReact: 202 as for `queued`), with the upload as its
  // owner's GET shows it now: masked while it processes, completed once it is; a failure, or a read
  // not received, the masked entity with the thumbnail S3's reply showed, the owner's next GET showing the failure.
  async #settled(text: UploadText, thumbnail: ThumbnailFacts | null): Promise<Response> {
    const shown = await by(
      this.#deps,
      () =>
        reply(() =>
          storeCall(this.#c, this.#deps, (s, b) =>
            s.getMedia(b, { credential: this.#a.upload.credential(), id: this.#id }),
          ),
        ),
      this.#deps.now() + STORE_CALL_MS,
    );
    if (
      shown !== CUT &&
      shown !== UNKNOWN &&
      shown.status === "ok" &&
      (shown.value.status === "ok" || shown.value.status === "processing")
    ) {
      return this.#c.json(shown.value.media, 202);
    }
    return this.#accepted(text, thumbnail);
  }

  // v2's 202: the upload as its owner's GET shows it while it processes (url, preview_url, meta and blurhash null), with
  // its current thumbnail as S3 answered it (#1828 PR6 D-5: its preview_url, meta.small and blurhash).
  #accepted(text: UploadText, thumbnail: ThumbnailFacts | null): Response {
    const masked = processingMedia(
      presentMedia({
        id: this.#id,
        type: this.#kind,
        url: "",
        preview_url: null,
        description: storedMediaDescription(text.description),
        meta: null,
        focus_x: text.focus === undefined ? null : text.focus.x,
        focus_y: text.focus?.y ?? 0,
        blurhash: null,
        remote: 0,
        cached: null,
        cached_preview: null,
      }),
    );
    const media =
      thumbnail === null
        ? masked
        : {
            ...masked,
            preview_url: thumbnail.preview_url,
            meta: thumbnail.small === null ? null : { small: thumbnail.small },
            blurhash: thumbnail.blurhash,
          };
    return this.#c.json(media, 202);
  }

  // v1: S9 every V1_POLL_MS until it shows an outcome or the route's cut, then S10.
  async #wait(): Promise<Response> {
    const deps = this.#deps;
    while (!this.#answered && deps.now() < this.#cut) {
      // Each read V1_POLL_MS after the start of the one before, its reply's time included.
      const started = deps.now();
      const read = await by(
        deps,
        () => reply(() => storeCall(this.#c, deps, (s, b) => s.v1Outcome(b, { id: this.#id, token: this.#token }))),
        this.#cut,
      );
      if (read === CUT || (read !== UNKNOWN && read.status !== "processing")) {
        break;
      }
      const next = Math.min(started + V1_POLL_MS, this.#cut);
      if (next > deps.now()) {
        await timer(deps, next - deps.now(), new AbortController().signal);
      }
    }
    return this.#decide();
  }

  // S10: the Store's decision, sent as it is; a reply not received is 503 (W5).
  async #decide(): Promise<Response> {
    if (this.#answered) {
      return mastodonError(503, PROCESS_TOO_LONG);
    }
    // Awaited until the give-up, and no shorter (one clock per request): no reply by then is W5's.
    const final = await by(
      this.#deps,
      () => reply(() => storeCall(this.#c, this.#deps, (s, b) => s.v1Final(b, { id: this.#id, token: this.#token }))),
      this.#giveUp,
    );
    if (final === CUT || final === UNKNOWN) {
      return mastodonError(503, PROCESS_TOO_LONG);
    }
    switch (final.status) {
      case 200:
        return this.#c.json(final.media);
      case 422:
        return mastodonError(422, OUTSIDE_ENVELOPE);
      case 500:
        return mastodonError(500, PROCESSING_ERROR);
      case 503:
        return mastodonError(503, PROCESS_TOO_LONG);
      case "maintenance":
        return maintenanceError();
    }
  }

  // The request's cleanup steps: each awaited at most its bound, none awaited by the answer.
  #deleteInput(): void {
    this.#a.cleanup.add(() => this.#inputDelete());
  }

  // incoming/<id> deleted, awaited at most R2_CALL_MS; only under the authority S2's `released` or S3's
  // `refused_cleanup_yours` gave.
  #inputDelete(strict = false): Promise<unknown> {
    return bounded(
      this.#deps,
      () => this.#c.env.MEDIA.delete(incomingKey(this.#id)),
      R2_CALL_MS,
      (fields) => console.warn({ event: "kopje.media.upload.input_delete_failed", ...fields }),
      strict,
    );
  }

  #abortUpload(upload: R2MultipartUpload): void {
    this.#a.cleanup.step(
      R2_CALL_MS,
      () => upload.abort(),
      (fields) => console.warn({ event: "kopje.media.upload.abort_failed", ...fields }),
    );
  }

  // The reservation, released from this request: doomed unless the processor holds it (domain/media.ts abandonMedia).
  // Nothing of mediaKeys was written by the route, so nothing of it is deleted here.
  #abandon(): void {
    this.#a.cleanup.step(
      STORE_CALL_MS,
      () =>
        storeCall(this.#c, this.#deps, (s, b) =>
          s.abandonMedia(b, { credential: this.#a.upload.credential(), id: this.#id }),
        ),
      (fields) => console.warn({ event: "kopje.media.upload.abandon_failed", ...fields }),
    );
  }
}
