import { HTTPException } from "hono/http-exception";

import { parseFocus } from "../domain/media-focus";
import {
  type ActivationInput,
  AV_UPLOAD_LIMIT,
  type AvKind,
  type Endpoint,
  PART_BYTES,
  type QueueRefusal,
  SNIFF_BYTES,
  T_REPLY,
  type UploadText,
  V1_POLL_MS,
  V1_TIME_MS,
} from "../domain/media-processing";
import { presentMedia, processingMedia } from "../domain/status-presenter";
import { sniffAvUpload } from "../platform/av-bytes";
import { readConfig } from "../platform/config";
import { errorFields } from "../platform/error-message";
import { sniffImageType } from "../platform/image-bytes";
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
  type FormCheck,
  INVALID_TYPE,
  MEDIA_BODY_LIMIT,
  mediaProblem,
  receiveImageUpload,
  reserve,
  THUMBNAIL_MUST_BE_BLANK,
  TOO_LARGE,
  type Upload,
  type UploadOutcome,
  uploadParams,
} from "./media";
import { API_BODY_LIMIT, MULTIPART_PARTS, type Params, parseBody, refusedStatus } from "./params";

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

const CHECK: FormCheck = (params) => {
  const problem = mediaProblem(params, params.get("description"));
  return problem === undefined ? null : { status: 422, error: problem };
};

function answerOf(c: ApiContext, outcome: UploadOutcome): Response {
  return outcome.ok ? c.json(outcome.media) : mastodonError(outcome.status, outcome.error);
}

export const uploadMedia: ApiHandler = async (c, deps) => {
  // The request clock's origin, the v1 wait's arrival.
  const arrival = deps.now();
  const activation = avUploadActivation(c.env, deps);
  const reserved = await reserve(
    c,
    deps,
    () => userCredential(c, deps),
    activation === undefined ? undefined : { build: activation.build },
  );
  if (!reserved.ok) {
    await c.req.raw.body?.cancel();
    return mastodonError(reserved.status, reserved.error);
  }
  const { upload } = reserved;
  if (activation === undefined || upload.imagesRefusal === undefined) {
    return answerOf(c, await receiveImageUpload(c, deps, upload, CHECK, c.req.raw));
  }
  const endpoint: Endpoint = new URL(c.req.url).pathname.startsWith("/api/v1/") ? "v1" : "v2";
  return receiveActive(c, deps, { upload, activation, endpoint, arrival });
};

// ---- Messages (design 4.7, 4.11, 4.14)

const BUSY = "Media processing is busy. Try again in a moment.";
const RECEIVE_TOO_LONG = "Media processing took too long to receive. Try again.";
const PROCESS_TOO_LONG = "Media processing took too long. Try a shorter file.";
const UNAVAILABLE = "Media processing is unavailable. Try again later.";
const AV_TOO_LARGE = "Validation failed: File file size must be less than 90 MB";
const OUTSIDE_ENVELOPE = "Validation failed: File is too long or too large to process";
const PROCESSING_ERROR = "Error processing thumbnail for uploaded media";
// A second `file` part after a video or audio one (Mastodon reads the last: docs/mastodon-deviations.md).
const REPEATED_FILE = "Validation failed: File was sent more than once";

// ---- Timing

type Active = { upload: Upload; activation: ActivationInput; endpoint: Endpoint; arrival: number };

const CUT: unique symbol = Symbol("cut");
const UNKNOWN: unique symbol = Symbol("unknown");

// The wait the route's cuts race (deps.wait, else a timer).
function waitOf(deps: ApiDeps): (ms: number) => Promise<void> {
  return deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

// `work` raced against `end` on the route's clock: its value, or CUT when the cut comes first.
async function by<T>(deps: ApiDeps, work: Promise<T>, end: number): Promise<T | typeof CUT> {
  work.catch(() => {});
  if (end === Infinity) {
    return work;
  }
  const left = end - deps.now();
  if (left <= 0) {
    return CUT;
  }
  return Promise.race([work, waitOf(deps)(left).then((): typeof CUT => CUT)]);
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

// A call repeated once when its reply is not received (S1, S3: each idempotent for the reservation, 1.4), both cut at
// `end`.
async function repeatedOnce<T>(
  deps: ApiDeps,
  call: () => Promise<T>,
  end: number,
): Promise<T | typeof UNKNOWN | typeof CUT> {
  const first = await by(deps, reply(call), end);
  if (first !== UNKNOWN) {
    return first;
  }
  return by(deps, reply(call), end);
}

class Cut extends Error {}

// A reader guard that rejects each pull still waiting at `end` (Cut).
function cutGuard(deps: ApiDeps, end: number) {
  return async <T>(read: Promise<T>): Promise<T> => {
    const settled = await by(deps, read, end);
    if (settled === CUT) {
      throw new Cut();
    }
    return settled;
  };
}

// ---- The sniff

type Text = { head: PartHead; body: Uint8Array };

// The first `file` part's head and first SNIFF_BYTES, after the parts before it (kept, as text); null when the body has
// no such part (or more parts than Rack takes), and the image pipeline answers it.
async function firstFile(reader: MultipartStream): Promise<{ prefix: Uint8Array; texts: Text[] } | null> {
  const texts: Text[] = [];
  for (;;) {
    const head = await reader.next();
    if (head === null || texts.length >= MULTIPART_PARTS) {
      return null;
    }
    if (head.name === "file" && head.file) {
      return { prefix: await reader.peek(SNIFF_BYTES), texts };
    }
    texts.push({ head, body: await collected(reader, MEDIA_BODY_LIMIT) });
  }
}

// The current part's body, within `limit` bytes (StagingRefusal 413 past it).
async function collected(reader: MultipartStream, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await reader.body((chunk) => {
    size += chunk.byteLength;
    if (size > limit) {
      throw new StagingRefusal(413, "Request body is too large");
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
  const today = async (from: Request) => answerOf(c, await receiveImageUpload(c, deps, a.upload, CHECK, from));
  const boundary = multipartBoundary(request.headers.get("content-type") ?? "");
  if (boundary === null || request.body === null) {
    return today(request);
  }
  // The prefix: bounded by MEDIA_BODY_LIMIT and the reservation's deadline, as the image pipeline's whole body is.
  const reader = new MultipartStream(
    request.body as ReadableStream<Uint8Array>,
    boundary,
    MEDIA_BODY_LIMIT,
    cutGuard(deps, a.upload.deadline),
  );
  let found: Awaited<ReturnType<typeof firstFile>>;
  try {
    found = await firstFile(reader);
  } catch (error) {
    if (error instanceof Cut || (error instanceof MultipartRefused && error.reason === "limit")) {
      await reader.cancel();
      await discard(c, deps, a.upload, "keep");
      return mastodonError(422, error instanceof Cut ? EXPIRED_MESSAGE : TOO_LARGE);
    }
    if (error instanceof MultipartRefused || error instanceof StagingRefusal) {
      return today(replayed(request, reader));
    }
    await reader.cancel();
    await discard(c, deps, a.upload, "keep");
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
    await discard(c, deps, a.upload, "keep");
    const refused = budgetRefusal(a.upload.imagesRefusal);
    return mastodonError(refused.status, refused.error);
  }
  const kind = sniffAvUpload(found.prefix);
  if (kind === null) {
    return today(replayed(request, reader));
  }
  const av = new AvUpload(c, deps, a, reader, kind, found.texts);
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
// meanwhile (design 4.14, "Not active"), else 503.
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
      return mastodonError(503, UNAVAILABLE);
  }
}

class AvUpload {
  readonly #c: ApiContext;
  readonly #deps: ApiDeps;
  readonly #a: Active;
  readonly #reader: MultipartStream;
  readonly #kind: AvKind;
  readonly #texts: Text[];
  // The route's cut (v1: arrival + V1_TIME_MS - T_REPLY; v2: none) and its give-up (v1: arrival + V1_TIME_MS).
  readonly #cut: number;
  readonly #giveUp: number;
  // Set once the v1 route answered at its give-up: no Store call is started after it but the staging's cleanup.
  #answered = false;

  constructor(c: ApiContext, deps: ApiDeps, a: Active, reader: MultipartStream, kind: AvKind, texts: Text[]) {
    this.#c = c;
    this.#deps = deps;
    this.#a = a;
    this.#reader = reader;
    this.#kind = kind;
    this.#texts = texts;
    this.#cut = a.endpoint === "v1" ? a.arrival + V1_TIME_MS - T_REPLY : Infinity;
    this.#giveUp = a.endpoint === "v1" ? a.arrival + V1_TIME_MS : Infinity;
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
    const left = this.#giveUp - this.#deps.now();
    const first = await Promise.race([
      flow,
      left <= 0 ? Promise.resolve(CUT) : waitOf(this.#deps)(left).then((): typeof CUT => CUT),
    ]);
    if (first !== CUT) {
      return first;
    }
    this.#answered = true;
    afterResponse(
      this.#c,
      flow.catch((error: unknown) => {
        console.error({ event: "kopje.media.upload.failed", ...errorFields(error) });
      }),
    );
    return mastodonError(503, PROCESS_TOO_LONG);
  }

  async run(today: (from: Request) => Promise<Response>): Promise<Response> {
    const refused = this.#beforeSlot();
    if (refused !== null) {
      await this.#reader.cancel();
      await this.#abandon();
      return mastodonError(refused.status, refused.answer);
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
      await this.#abandon();
      return this.#slotRefusal(taken === UNKNOWN ? "unknown" : taken.status);
    }
    this.#reader.forget();
    const staged = await this.#stage(Math.min(readBefore + taken.stagingMs, this.#cut));
    if ("refusal" in staged) {
      return this.#exit(taken.stagedAt, staged.refusal);
    }
    return this.#queue(taken.stagedAt, staged);
  }

  // The refusals the parts before the file part decide, before any slot is taken (P7).
  #beforeSlot(): StagingRefusal | null {
    if (this.#texts.some((t) => t.head.name === "file")) {
      return new StagingRefusal(422, REPEATED_FILE);
    }
    if (this.#texts.some((t) => t.head.name === "thumbnail" && t.head.file)) {
      return new StagingRefusal(422, THUMBNAIL_MUST_BE_BLANK);
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
  async #stage(end: number): Promise<{ bytes: number; params: Params } | { refusal: StagingRefusal }> {
    const deps = this.#deps;
    const guard = cutGuard(deps, end);
    this.#reader.limit = Number.MAX_SAFE_INTEGER;
    this.#reader.guard = guard;
    let upload: R2MultipartUpload | null = null;
    try {
      upload = await guard(this.#c.env.MEDIA.createMultipartUpload(incomingKey(this.#id)));
      const multipart = upload;
      const parts: R2UploadedPart[] = [];
      let buffer = new Uint8Array(PART_BYTES);
      let fill = 0;
      let bytes = 0;
      const flush = async () => {
        parts.push(await guard(multipart.uploadPart(parts.length + 1, buffer.subarray(0, fill))));
        buffer = new Uint8Array(PART_BYTES);
        fill = 0;
      };
      await this.#reader.body(async (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > AV_UPLOAD_LIMIT) {
          throw new StagingRefusal(422, AV_TOO_LARGE);
        }
        for (let at = 0; at < chunk.byteLength;) {
          const n = Math.min(PART_BYTES - fill, chunk.byteLength - at);
          buffer.set(chunk.subarray(at, at + n), fill);
          fill += n;
          at += n;
          if (fill === PART_BYTES) {
            await flush();
          }
        }
      });
      let weighed = this.#texts.reduce((sum, t) => sum + weight(t), 0);
      for (;;) {
        const head = await this.#reader.next();
        if (head === null) {
          break;
        }
        if (head.name === "file") {
          throw new StagingRefusal(422, REPEATED_FILE);
        }
        if (head.name === "thumbnail" && head.file) {
          throw new StagingRefusal(422, THUMBNAIL_MUST_BE_BLANK);
        }
        const text = { head, body: await collected(this.#reader, API_BODY_LIMIT) };
        weighed += weight(text);
        if (weighed > API_BODY_LIMIT || this.#texts.length >= MULTIPART_PARTS) {
          throw new StagingRefusal(413, "Request body is too large");
        }
        this.#texts.push(text);
      }
      await this.#reader.cancel();
      const params = await this.#params();
      if ("error" in params) {
        throw new StagingRefusal(params.status ?? 422, params.error);
      }
      if (fill > 0) {
        await flush();
      }
      await guard(multipart.complete(parts));
      upload = null;
      return { bytes, params };
    } catch (error) {
      await this.#reader.cancel();
      if (upload !== null) {
        await upload.abort().catch((abortError: unknown) => {
          console.warn({ event: "kopje.media.upload.abort_failed", ...errorFields(abortError) });
        });
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

  // The text parts as the image pipeline reads a form (its parser, the query merged and the form's bounds): the parts
  // as sent, the file part left out, parsed again by the runtime's form parser, and the description and thumbnail
  // rules (mediaProblem).
  async #params(): Promise<Params | { error: string; status?: 400 | 413 }> {
    const boundary = multipartBoundary(this.#c.req.raw.headers.get("content-type") ?? "") ?? "";
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const text of this.#texts) {
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
      form = await parseBody(`multipart/form-data; boundary="${boundary}"`, body, {
        names: ["file", "thumbnail"],
        maxBytes: 0,
      });
    } catch (error) {
      const status = refusedStatus(error);
      return status === undefined ? { error: FILE_BLANK } : { error: "Malformed request body", status };
    }
    const params = uploadParams(this.#c.req.raw, form, null);
    if ("error" in params) {
      return params;
    }
    const problem = mediaProblem(params, params.get("description"));
    return problem === undefined ? params : { error: problem };
  }

  // A staging exit (P7, the staging time): S2, and the input deleted only on its `released`; the reservation
  // abandoned; the refusal's answer.
  async #exit(stagedAt: number, refusal: StagingRefusal): Promise<Response> {
    // Not cut: v1's give-up answers in its place (v1), and the release goes on after it.
    const released = await reply(() =>
      storeCall(this.#c, this.#deps, (s, b) => s.releaseStaging(b, { id: this.#id, token: this.#token, stagedAt })),
    );
    if (released !== UNKNOWN && released.status === "released") {
      await this.#deleteInput();
    }
    await this.#abandon();
    return mastodonError(refusal.status, refusal.answer);
  }

  async #queue(stagedAt: number, staged: { bytes: number; params: Params }): Promise<Response> {
    if (this.#answered) {
      return mastodonError(503, PROCESS_TOO_LONG);
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
          }),
        ),
      this.#cut,
    );
    if (queued === CUT) {
      return this.#decide();
    }
    if (queued === UNKNOWN) {
      return mastodonError(503, UNAVAILABLE);
    }
    switch (queued.status) {
      case "queued":
        this.#dispatch(queued.teardownId);
        return this.#a.endpoint === "v2" ? this.#accepted(text) : this.#wait();
      case "settled":
        return this.#a.endpoint === "v2" ? this.#accepted(text) : this.#wait();
      case "refused_cleanup_yours":
        await this.#deleteInput();
        await this.#abandon();
        return queueRefusal(queued.reason);
      case "maintenance":
        return maintenanceError();
      case "gone":
        return mastodonError(503, UNAVAILABLE);
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

  // v2's 202: the upload as its owner's GET shows it while it processes (url, preview_url, meta and blurhash null).
  #accepted(text: UploadText): Response {
    const media = processingMedia(
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
    return this.#c.json(media, 202);
  }

  // v1: S9 every V1_POLL_MS until it shows an outcome or the route's cut, then S10.
  async #wait(): Promise<Response> {
    const deps = this.#deps;
    while (!this.#answered && deps.now() < this.#cut) {
      const read = await by(
        deps,
        reply(() => storeCall(this.#c, deps, (s, b) => s.v1Outcome(b, { id: this.#id, token: this.#token }))),
        this.#cut,
      );
      if (read === CUT || (read !== UNKNOWN && read.status !== "processing")) {
        break;
      }
      if ((await by(deps, waitOf(deps)(V1_POLL_MS), this.#cut)) === CUT) {
        break;
      }
    }
    return this.#decide();
  }

  // S10: the Store's decision, sent as it is; a reply not received is 503 (W5).
  async #decide(): Promise<Response> {
    if (this.#answered) {
      return mastodonError(503, PROCESS_TOO_LONG);
    }
    const final = await reply(() =>
      storeCall(this.#c, this.#deps, (s, b) => s.v1Final(b, { id: this.#id, token: this.#token })),
    );
    if (final === UNKNOWN) {
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

  async #deleteInput(): Promise<void> {
    try {
      await this.#c.env.MEDIA.delete(incomingKey(this.#id));
    } catch (error) {
      console.warn({ event: "kopje.media.upload.input_delete_failed", ...errorFields(error) });
    }
  }

  // The reservation, released from this request: doomed unless the processor holds it (domain/media.ts abandonMedia).
  // Nothing of mediaKeys was written by the route, so nothing of it is deleted here.
  async #abandon(): Promise<void> {
    try {
      await storeCall(this.#c, this.#deps, (s, b) =>
        s.abandonMedia(b, { credential: this.#a.upload.credential(), id: this.#id }),
      );
    } catch (error) {
      console.warn({ event: "kopje.media.upload.abandon_failed", ...errorFields(error) });
    }
  }
}
