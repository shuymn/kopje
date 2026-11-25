import { HTTPException } from "hono/http-exception";

import type { UserCredential } from "../domain/auth";
import { type MediaChanges, type MonthlyTransforms, SWEEP_BATCH } from "../domain/media";
import { parseFocus } from "../domain/media-focus";
import type { OwnerMedia } from "../domain/media-processing";
import type { MediaAttachment } from "../domain/status-presenter";
import { readBoundedBody } from "../platform/body";
import { accountMonthlyTransforms, readConfig } from "../platform/config";
import { errorFields } from "../platform/error-message";
import { IMAGE_MATRIX_LIMIT, IMAGE_SIZE_LIMIT, processImage, type ProcessedImage } from "../platform/images";
import { deleteKeys, fileKey, mediaKeys, originalKey, sweptKeys } from "../platform/media-files";
import { callStore, type StoreResolver } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";
import { MAX_MEDIA_DESCRIPTION_LENGTH, yieldsMoreThan } from "../platform/stored-bounds";
import {
  afterResponse,
  type AfterResponse,
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { mastodonError, recordNotFound } from "./errors";
import { type FileRule, type ParamEntry, type Params, parseBody, readQuery, refusedStatus } from "./params";

// /api/v1/media and /api/v2/media: upload, read and describe own unattached media.
//
// Accepted: JPEG, PNG, GIF, WebP and AVIF, by their signature (MEDIA-4), up to 16 MB and 16,777,216 pixels (RES-1).
// Each is re-encoded through Images (EXIF and location removed, long edge capped, a preview made) and only the
// re-encoded files are served; when re-encoding fails the upload is refused and nothing is served (MEDIA-3). The
// preview's blurhash comes from Images' RGBA output of it (platform/images.ts processImage), given up RGBA_CALL_MS
// after it starts or UPLOAD_SAVE_RESERVE_MS before the writer deadline, whichever is first: it delays the save by at
// most RGBA_CALL_MS, and when it fails or is given up the upload is kept without one (docs/mastodon-deviations.md,
// "Media").
// Video and audio are refused with 422: the Images binding transforms images only, and serving an un-transcoded
// container would publish its metadata (location included) as uploaded.
//
// Upload order: the Store reserves the row (authorization, the 30-attempts-per-30-minutes budget, and a check of the
// monthly Images budgets, RES-6) before the body is read, and revalidates it and charges the budgets right before
// Images is called (domain/media.ts), so an unauthenticated, over-budget or expired request costs no transformation. Processing is synchronous, so v2 answers 200 like v1 (Mastodon answers 200 when
// processing finished in the request).

// The file plus the form's other fields (description, focus, and a thumbnail, which counts toward this bound and is
// refused): a description of MAX_MEDIA_DESCRIPTION_LENGTH four-byte code points (40,000 bytes) with its part headers
// fits beside a file at IMAGE_SIZE_LIMIT.
export const MEDIA_BODY_LIMIT = IMAGE_SIZE_LIMIT + 64 * 1024;

export const THUMBNAIL_MUST_BE_BLANK = "Validation failed: Thumbnail must be blank";

// MediaAttachment validates `thumbnail, absence: true` unless the media is audio or video (Mastodon v4.5.11
// app/models/media_attachment.rb:207); every local upload Kopje accepts is an image, so any thumbnail is refused.
// Sent: any file part, or non-empty text (a data URI is assigned through Paperclip's DataUriAdapter; other text has
// no handler and answers 500 there, 422 here). Empty text or JSON null is absent. Only presence is read.
export function thumbnailSent(value: string | File | undefined): boolean {
  return value !== undefined && value !== "";
}

// The validation error of an upload or update form: the description first, then the thumbnail (read only when the
// description passes).
export function mediaProblem(params: Params, description: string | undefined): string | undefined {
  return (
    descriptionProblem(description) ??
    (thumbnailSent(params.file("thumbnail") ?? params.get("thumbnail")) ? THUMBNAIL_MUST_BE_BLANK : undefined)
  );
}

// PUT /api/v1/media/:id reads a thumbnail only to refuse it: no allowance beyond its part's headers (RES-1).
const THUMBNAIL_FILE: FileRule = { names: ["thumbnail"], maxBytes: 0 };

export const TOO_LARGE = "Validation failed: File file size must be less than 16 MB";
export const INVALID_TYPE = "Validation failed: File content type is invalid";
export const FILE_BLANK = "Validation failed: File can't be blank";
// The message of an image past IMAGE_MATRIX_LIMIT pixels, without its attribute.
export const PIXELS_PROBLEM = `dimensions exceed ${IMAGE_MATRIX_LIMIT} pixels`;

function mediaId(c: ApiContext): string {
  return c.req.param("id") ?? "";
}

// Whether `text` has more than `max` characters (code points): by its length when that settles it (a code point is one
// or two UTF-16 code units), else counting no further than max + 1.
function exceedsCharacters(text: string, max: number): boolean {
  if (text.length <= max) {
    return false;
  }
  return text.length > 2 * max || yieldsMoreThan(text, max);
}

// A local description is at most MAX_MEDIA_DESCRIPTION_LENGTH code points (MediaAttachment::MAX_DESCRIPTION_LENGTH),
// the bound its stored value is cut at, so storedMediaDescription never shortens one this accepts.
export function descriptionProblem(description: string | undefined): string | undefined {
  return description !== undefined && exceedsCharacters(description, MAX_MEDIA_DESCRIPTION_LENGTH)
    ? `Validation failed: Description is too long (maximum is ${MAX_MEDIA_DESCRIPTION_LENGTH} characters)`
    : undefined;
}

// Each text field of the upload form is bounded on its own, and so is their number, so a small image cannot carry
// megabytes of text into later processing (RES-1): the description by its own rule (descriptionProblem, which reads a
// longer one by its length and counts no further than one code point past the limit), so every description too long
// gets the description's message whatever its plane; the others at the longest valid description's UTF-16 length.
export const MAX_FIELD_LENGTH = 2 * MAX_MEDIA_DESCRIPTION_LENGTH;
const MAX_FIELDS = 16;

// `status`: a request the parameter parsers refuse (params.ts), else the form's 422.
type MediaForm = { file: Uint8Array; params: Params } | { error: string; status?: 400 | 413 };

// The file parameters of an upload form, with readParams' query merge (a declared name's body value wins).
const UPLOAD_FILES = ["file", "thumbnail"];

// The multipart body, bounded before it is parsed (RES-1). Only `file` and `thumbnail` are read as files.
// Reads the body within `ms` of wall time (the reservation's deadline): a client that sends its body slowly cannot
// keep a reservation open past it.
async function readWithin(request: Request, ms: number): Promise<Uint8Array | "too-large" | "expired"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), Math.max(0, ms));
  });
  try {
    return await Promise.race([readBoundedBody(request, MEDIA_BODY_LIMIT), expired]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function refusedForm(status: 400 | 413): { error: string; status: 400 | 413 } {
  return { status, error: status === 413 ? "Request body is too large" : "Malformed request body" };
}

async function readMediaForm(request: Request, ms: number): Promise<MediaForm> {
  const body = await readWithin(request, ms);
  if (body === "expired") {
    return { error: EXPIRED_MESSAGE };
  }
  if (body === "too-large") {
    return { error: TOO_LARGE };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return { error: FILE_BLANK };
  }
  let form: Params;
  try {
    // Rails' last-part rule (params.ts): of repeated `file` or `thumbnail` parts, text or file, the last is read.
    form = await parseBody(contentType, body, { names: UPLOAD_FILES, maxBytes: IMAGE_SIZE_LIMIT });
  } catch (error) {
    const status = refusedStatus(error);
    return status === undefined ? { error: FILE_BLANK } : refusedForm(status);
  }
  const file = form.file("file");
  const params = uploadParams(
    request,
    form,
    file === undefined ? FILE_BLANK : file.size > IMAGE_SIZE_LIMIT ? TOO_LARGE : null,
  );
  return "error" in params ? params : { file: new Uint8Array(await (file as File).arrayBuffer()), params };
}

// The upload form's parameters, the query merged, and the form's bounds checked: `form` holds the body's parts (the
// video or audio path's text parts alone, its file streamed apart, mastodon/media-av.ts), `fileProblem` what the file
// part answers (absent or too large), judged after the query. The bounds hold for what is sent: body fields and query parameters together, each text pair as sent
// (Params#sent: also one a later pair or the query replaced, whatever it nested under). A thumbnail is only checked for
// presence and refused, and a description is judged by its own rule, so neither length is bounded here (the body's
// is).
export function uploadParams(
  request: Request,
  form: Params,
  fileProblem: string | null,
): Params | { error: string; status?: 400 | 413 } {
  const query = readQuery(request);
  if (!query.ok) {
    return refusedForm(query.status);
  }
  if (fileProblem !== null) {
    return { error: fileProblem };
  }
  const params = form.withQuery(query.params, UPLOAD_FILES);
  const long = ([key, value]: ParamEntry) =>
    key !== "thumbnail" && key !== "description" && value.length > MAX_FIELD_LENGTH;
  if (params.sent.length > MAX_FIELDS || params.sent.some(long)) {
    return { error: "Validation failed: A form field is too long" };
  }
  return params;
}

// `problem`: which validation error a 422 is, for a caller that names its own attribute (profile images,
// mastodon/accounts.ts storeProfileImages).
export type Failure = { status: number; error: string; problem?: "content_type" | "pixels" | "expired" };

// What the pipeline reads of the request context: the bindings and the raw request (its body is the form).
export type UploadContext = { env: Env; req: { raw: Request } };

const PROCESSING_FAILURES: Record<"unsupported" | "too_large" | "quota" | "failed", Failure> = {
  unsupported: { status: 422, error: INVALID_TYPE, problem: "content_type" },
  too_large: { status: 422, error: `Validation failed: File ${PIXELS_PROBLEM}`, problem: "pixels" },
  quota: { status: 503, error: "Media processing is unavailable. Try again later." },
  failed: { status: 500, error: "Error processing uploaded media" },
};

export function budgetRefusal(scope: "account" | "instance"): Failure {
  return scope === "account"
    ? { status: 429, error: "Your media processing budget for the month is used up" }
    : { status: 429, error: "This server's media processing budget for the month is used up" };
}

export type UploadOutcome = { ok: true; media: MediaAttachment } | ({ ok: false } & Failure);

// What the caller checks in the form once it is read, before any transformation is spent: a failure refuses the
// upload (the API checks the description).
export type FormCheck = (params: Params) => Failure | null | Promise<Failure | null>;

// A reservation (domain/media.ts reserveMedia): the row's id and file token, the writer deadline, and the budgets and
// credential every later Store call of the upload takes. `imagesRefusal`: on the active path (reserved with
// `avCandidate`, uploads active), the Images budget an image would be refused for, or null; absent otherwise.
export type Upload = {
  id: string;
  token: string;
  deadline: number;
  monthlyTransforms: MonthlyTransforms;
  credential: () => UserCredential;
  imagesRefusal?: "account" | "instance" | null;
};

// `avCandidate`: the media upload route's, with the processor bound and a positive upload budget (mastodon/media-av.ts);
// profile images and emoji reserve without it, as before #1828.
export async function reserve(
  c: UploadContext,
  deps: ApiDeps,
  credential: () => UserCredential,
  avCandidate?: { build: string },
): Promise<{ ok: true; upload: Upload } | ({ ok: false } & Failure)> {
  const token = deps.randomToken();
  const config = readConfig(c.env);
  // The app answers 503 before any route when the env is invalid, so this is the validated value.
  const monthlyTransforms = config.ok
    ? { instance: config.config.IMAGES_MONTHLY_TRANSFORMS, account: accountMonthlyTransforms(config.config) }
    : { instance: 0, account: 0 };
  const reserved = authorized(
    await storeCall(c, deps, (s, b) =>
      s.reserveMedia(b, {
        credential: credential(),
        token,
        monthlyTransforms,
        ...(avCandidate === undefined ? {} : { avCandidate }),
        now: deps.now(),
      }),
    ),
  );
  if (reserved.status === "retry") {
    // The file token is taken (domain/media.ts mediaTokenTaken): nothing was reserved; the client may send it again.
    return { ok: false, status: 503, error: "The upload could not be reserved; try again" };
  }
  if (reserved.status !== "ok") {
    return {
      ok: false,
      ...(reserved.status === "rate_limited"
        ? { status: 429, error: "Too many requests" }
        : budgetRefusal(reserved.scope)),
    };
  }
  const upload: Upload = { id: reserved.id, token, deadline: reserved.deadline, monthlyTransforms, credential };
  return {
    ok: true,
    upload: "imagesRefusal" in reserved ? { ...upload, imagesRefusal: reserved.imagesRefusal } : upload,
  };
}

// The image pipeline of POST /api/v{1,2}/media for a reserved upload: read the form of `request` (the request itself,
// or the same body replayed, mastodon/media-av.ts), check it, transform, write, complete; a failure abandons the
// reservation.
export async function receiveImageUpload(
  c: UploadContext,
  deps: ApiDeps,
  upload: Upload,
  check: FormCheck,
  request: Request,
): Promise<UploadOutcome> {
  let outcome: Failure | MediaAttachment;
  try {
    outcome = await processUpload(c, deps, upload, check, request);
  } catch (error) {
    await discard(c, deps, upload, "keep");
    throw error;
  }
  if ("error" in outcome) {
    await discard(c, deps, upload, "keep");
    return { ok: false, ...outcome };
  }
  return { ok: true, media: outcome };
}

// What the upload keeps of its writer deadline after the preview's RGBA output: the deadline check, the three R2 puts
// (the original, at most IMAGE_SIZE_LIMIT, and both outputs) and up to two completeMedia calls must all finish before
// it, or the upload answers 422 although only its blurhash was late.
export const UPLOAD_SAVE_RESERVE_MS = 60_000;

export const EXPIRED_MESSAGE = "Validation failed: The upload expired";
const EXPIRED: Failure = { status: 422, error: EXPIRED_MESSAGE, problem: "expired" };

async function processUpload(
  c: UploadContext,
  deps: ApiDeps,
  upload: Upload,
  check: FormCheck,
  request: Request,
): Promise<Failure | MediaAttachment> {
  const form = await readMediaForm(request, upload.deadline - deps.now());
  if ("error" in form) {
    return { status: form.status ?? 422, error: form.error };
  }
  const refused = await check(form.params);
  if (refused !== null) {
    return refused;
  }
  return transformReserved(c, deps, upload, form.file, {
    description: form.params.get("description") ?? "",
    focus: parseFocus(form.params.get("focus")),
  });
}

// The transformation of a reserved upload's bytes: the Store revalidates the reservation and charges the
// transformations, Images re-encodes, R2 keeps the original and the served files, and the Store completes the row.
async function transformReserved(
  c: UploadContext,
  deps: ApiDeps,
  upload: Upload,
  bytes: Uint8Array,
  fields: { description: string; focus: { x: number; y: number } | undefined },
): Promise<Failure | MediaAttachment> {
  const { id, token, credential } = upload;
  // The Store revalidates the reservation with the time now and charges the transformations to this month.
  const started = authorized(
    await storeCall(c, deps, (s, b) =>
      s.startTransforms(b, {
        credential: credential(),
        id,
        monthlyTransforms: upload.monthlyTransforms,
        now: deps.now(),
      }),
    ),
  );
  if (started.status === "expired") {
    return EXPIRED;
  }
  if (started.status === "budget_exhausted") {
    return budgetRefusal(started.scope);
  }
  const processed = await processImage(deps.images(c.env), bytes, {
    blurhash: { end: upload.deadline - UPLOAD_SAVE_RESERVE_MS, now: deps.now },
  });
  if (!processed.ok) {
    if (processed.reason === "quota") {
      console.warn({ event: "kopje.media.images_quota" });
    } else if (processed.reason === "failed") {
      console.error({ event: "kopje.media.transform_failed", detail: processed.detail ?? null });
    }
    return PROCESSING_FAILURES[processed.reason];
  }
  if (processed.image.blurhash === null) {
    console.warn({ event: "kopje.media.no_blurhash" });
  }
  // The writer deadline fences the sweep: no write starts after it, and the Store refuses to complete after it, so a
  // reservation the sweep may delete has no writer left (domain/media.ts).
  if (deps.now() >= upload.deadline) {
    return EXPIRED;
  }
  await writeFiles(c.env.MEDIA, id, token, bytes, processed.image);
  const { full, small, blurhash } = processed.image;
  const complete = async () =>
    authorized(
      await storeCall(c, deps, (s, b) =>
        s.completeMedia(b, {
          credential: credential(),
          id,
          contentType: full.contentType,
          original: { width: full.width, height: full.height },
          small: { width: small.width, height: small.height },
          animated: full.animated,
          blurhash,
          description: fields.description,
          focus: fields.focus,
        }),
      ),
    );
  let media: MediaAttachment | null;
  try {
    media = await complete();
  } catch (error) {
    // The completion may have committed and only its answer been lost: completing again is idempotent and answers
    // with the media if it did.
    if (error instanceof HTTPException) {
      throw error;
    }
    media = await complete();
  }
  return media ?? EXPIRED;
}

// A completed upload that is to become an avatar or header, made from bytes the caller has read and checked. The
// helper owns the reservation until it answers ok, and discards it on any failure, thrown errors and a lost completion
// answer included (discard). After ok the caller owns the upload until the Store applies it, and discards it if that
// does not commit.
export async function storeProfileImage(
  c: UploadContext,
  deps: ApiDeps,
  credential: () => UserCredential,
  bytes: Uint8Array,
): Promise<{ ok: true; upload: ProfileUpload } | ({ ok: false } & Failure)> {
  const reserved = await reserve(c, deps, credential);
  if (!reserved.ok) {
    return reserved;
  }
  const { upload } = reserved;
  let outcome: Failure | MediaAttachment;
  try {
    outcome = await transformReserved(c, deps, upload, bytes, { description: "", focus: undefined });
  } catch (error) {
    await discard(c, deps, upload);
    throw error;
  }
  if ("error" in outcome) {
    await discard(c, deps, upload);
    return { ok: false, ...outcome };
  }
  return { ok: true, upload };
}

export type ProfileUpload = Pick<Upload, "id" | "token" | "credential">;

// The original is kept (private, for backups) next to the served files. Keys come from the Store's id and token only.
// Every write settles before this returns, so cleanup after a failure never races a write still in flight.
export async function writeFiles(
  bucket: R2Bucket,
  id: string,
  token: string,
  original: Uint8Array,
  image: ProcessedImage,
): Promise<void> {
  const results = await Promise.allSettled([
    bucket.put(originalKey(id), original, { httpMetadata: { contentType: image.original.type } }),
    bucket.put(fileKey(token, "full"), image.full.bytes, { httpMetadata: { contentType: image.full.contentType } }),
    bucket.put(fileKey(token, "small"), image.small.bytes, { httpMetadata: { contentType: image.small.contentType } }),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) {
    throw failed.reason;
  }
}

// A failed or unused upload. The Store decides first: it dooms a reservation that never completed (its writer, this
// request, has settled every write), or keeps an upload whose completion committed although its answer was lost. A
// kept upload stays for POST /api/v{1,2}/media (`keep`: an unattached upload the client may still find, swept after
// its grace period), and is doomed as DELETE /api/v1/media/:id dooms one for a profile image (`doom`: nobody else can
// use it), the sweep deleting its objects. Only a doomed or
// vanished reservation's objects are deleted here. If the Store cannot be asked, the objects stay for the sweep, which
// deletes them with the reservation once its writer deadline has passed, or with a completed upload once its grace
// period has (DETACHED_GRACE_MS).
export async function discard(
  c: UploadContext,
  deps: ApiDeps,
  upload: ProfileUpload,
  completed: "keep" | "doom" = "doom",
): Promise<void> {
  const { id, token } = upload;
  try {
    const outcome = authorized(
      await storeCall(c, deps, (s, b) => s.abandonMedia(b, { credential: upload.credential(), id })),
    );
    if (outcome !== "kept") {
      await c.env.MEDIA.delete(mediaKeys(id, token));
      return;
    }
    if (completed === "keep") {
      return;
    }
    authorized(await storeCall(c, deps, (s, b) => s.deleteMedia(b, { credential: upload.credential(), id })));
  } catch (error) {
    console.error({ event: "kopje.media.abandon_failed", ...errorFields(error) });
  }
}

// The cleanup of a profile request that did not commit: each upload it owns is discarded in turn, then a sweep runs
// after the response, so what was discarded, here or by storeProfileImage, goes now rather than at the next cron.
export async function discardProfileUploads(
  c: UploadContext & AfterResponse,
  deps: ApiDeps,
  owned: readonly ProfileUpload[],
): Promise<void> {
  for (const upload of owned) {
    await discard(c, deps, upload);
  }
  sweepSoon(c, deps);
}

// An unfinished upload's processing failed, or passed its deadline (MediaController#check_processing).
const PROCESSING_ERROR = "Error processing thumbnail for uploaded media";

// The owner's answer for an upload (domain/media-processing.ts OwnerMedia): 200, 206 while processing (Mastodon's
// status_code_for_media_attachment), 422 once failed, 404 otherwise.
function ownerAnswer(c: ApiContext, outcome: OwnerMedia): Response {
  switch (outcome.status) {
    case "ok":
      return c.json(outcome.media);
    case "processing":
      return c.json(outcome.media, 206);
    case "failed":
      return mastodonError(422, PROCESSING_ERROR);
    case "not_found":
      return recordNotFound();
  }
}

// GET /api/v1/media/:id.
export const getMedia: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return ownerAnswer(c, authorized(await storeCall(c, deps, (s, b) => s.getMedia(b, { credential, id: mediaId(c) }))));
};

// PUT and PATCH /api/v1/media/:id: description and focus of own unattached media, also while it is processing.
// Attached media is described through media_attributes[] of a status edit, as in Mastodon.
export const updateMedia: ApiHandler = withParams(
  async (c, deps, p) => {
    const description = p.get("description");
    const problem = mediaProblem(p, description);
    const credential = userCredential(c, deps);
    if (problem !== undefined) {
      // MediaController#set_media_attachment finds the media (404) before update! validates it (422): a read, so it is
      // answered in readonly maintenance too, as an edit's target is (statuses.ts editTarget). The form's problem is
      // answered before the upload's own state, a failed one's included (Mastodon checks the processing first).
      const found = authorized(await storeCall(c, deps, (s, b) => s.getMedia(b, { credential, id: mediaId(c) })));
      return found.status === "not_found" ? recordNotFound() : mastodonError(422, problem);
    }
    const changes: MediaChanges = { description, focus: parseFocus(p.get("focus")) };
    return ownerAnswer(
      c,
      authorized(await storeCall(c, deps, (s, b) => s.updateMedia(b, { credential, id: mediaId(c), changes }))),
    );
  },
  { files: THUMBNAIL_FILE },
);

// DELETE /api/v1/media/:id: own unattached media, an upload still processing or failed included (S11); the sweep
// deletes its R2 objects after the response.
export const deleteMedia: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  const outcome = authorized(await storeCall(c, deps, (s, b) => s.deleteMedia(b, { credential, id: mediaId(c) })));
  if (outcome === "not_found") {
    return recordNotFound();
  }
  if (outcome === "in_use") {
    return mastodonError(422, "Media attachment is currently used by a status");
  }
  sweepSoon(c, deps);
  return c.json({});
};

export type SweepDeps = { build: (env: Env) => string; store: StoreResolver };

// Deletes doomed uploads: their R2 objects first, then their rows, one bounded batch (domain/media.ts). Returns how
// many rows were deleted. In maintenance the Store refuses and the sweep waits for the next run.
export async function sweepMedia(env: Env, deps: SweepDeps): Promise<number> {
  const store = deps.store(env);
  const build = deps.build(env);
  try {
    const expired = await callStore(() => store.expiredMedia(build, { limit: SWEEP_BATCH }));
    if (expired.length === 0) {
      return 0;
    }
    const keys = expired.flatMap((m) => (m.token === null ? [originalKey(m.id)] : sweptKeys(m.id, m.token)));
    await deleteKeys(env.MEDIA, keys);
    return await callStore(() => store.purgeMedia(build, { ids: expired.map((m) => m.id) }));
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return 0;
    }
    throw error;
  }
}

// Runs a sweep after the response (delete_media, a deleted upload or profile image), so the files go now rather than
// at the next cron.
export function sweepSoon(c: AfterResponse, deps: SweepDeps): void {
  afterResponse(
    c,
    sweepMedia(c.env, deps).catch((error: unknown) => {
      console.error({ event: "kopje.media.sweep_failed", ...errorFields(error) });
    }),
  );
}

// Deletes the R2 keys of tombstones that fell due (domain/media.ts), one bounded batch per run (the cron), then the
// tombstones. Nothing else: an object is never deleted because no row names it. In maintenance, a dump or an import the
// Store refuses and the run waits. Returns how many tombstones were handled.
export async function reconcileMedia(env: Env, deps: SweepDeps): Promise<number> {
  const store = deps.store(env);
  const build = deps.build(env);
  try {
    const due = await callStore(() => store.dueOrphans(build));
    if (due.length === 0) {
      return 0;
    }
    await deleteKeys(
      env.MEDIA,
      due.flatMap((orphan) => sweptKeys(orphan.id, orphan.token)),
    );
    return await callStore(() => store.forgetOrphans(build, { tokens: due.map((orphan) => orphan.token) }));
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return 0;
    }
    throw error;
  }
}
