import { selectSql } from "../db/columns";
import { MEDIA_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { type AudioFacts, isFrameRate, type VideoFacts } from "../platform/av-bytes";
import { iso } from "../platform/iso-time";
import { mediaUrl } from "../platform/media-files";
import { type Marker, restoreTime } from "../platform/restore-marker";
import { storedBlurhash, storedMediaDescription, storedMediaMeta } from "../platform/stored-bounds";
import { userMediaDeleteOperation, userReadOperation, userWriteOperation } from "./auth";
import { instanceOrigin } from "./instance-domain";
import { readState, writeState } from "./kopje-state";
import {
  AV_CANDIDATE_TYPE,
  AV_WRITE_WINDOW_MS,
  chargeUploadJob,
  deleteOwnMedia,
  DETACHED_GRACE_MS,
  DOOMED_AT,
  describeMedia,
  type MediaChanges,
  type MediaDeleted,
  liveMediaSql,
  setUp,
  uploadJobFits,
  ownerUri,
  uploadJobsSpent,
  WRITE_WINDOW_MS,
} from "./media";
import { NORMALIZE_PROFILE, probePassed, probeState, type ProbeState } from "./media-probes";
import { mediaDeleteOperation, readOperation, writeOperation } from "./operation";
import { isPlayable, type MediaAttachment, type MediaRow, presentMedia, processingMedia } from "./status-presenter";
import { MEDIA_COLUMN_MAP } from "./status-rows";

// The Store's side of a video or audio upload (#1828; the PR4 plan's section 1, and the TLA+ specification in
// spec/media-upload/, MediaUploadStore.tla, which names each operation S1-S13). An upload's record is its
// media_attachments row (the reservation, reserveMedia), its media_processing row while it is unfinished, and its
// media_av_slots row, the capacity it holds (migration 0121_media_processing). Who may act on what:
//
//   the upload route   stages the input under its slot (S1 takeAvSlot), cleans up only on S2's `released` or S3's
//                      `refused_cleanup_yours`, queues it (S3 queueNormalize, which charges the upload unit and hands
//                      the processor its teardown_id), and for v1 reads the outcome (S9) and has S10 decide the answer
//   the processor DO   starts the job (S4, which grants the slot), asks a grant before each final write (S5), completes
//                      (S6) or fails (S7) it, and confirms its container stopped (S8, by teardown_id) only once the
//                      stop is confirmed
//   the owner          deletes it (S11)
//   the cron           runs the dispatch round (S12, with the restore pass S13) and the incoming/ orphan pass
//
// Every writing operation applies, in its transaction and in this order (the spec's Norm): K1, maintenance (the
// kernel refuses the write, and the Store's method answers `maintenance`); K3, a reservation made at or before the last
// PITR restore (`restoredAt`, the restore marker the Store's method reads, src/store.ts): a staging row is deleted with
// its staging slot, a pending or running one fails `restored`, its slot kept; K4, a pending or running row at or past
// its deadline_at fails `deadline`, or for v1 (reply_by set) the upload is doomed (its row deleted, its slot kept);
// then the operation's own rule, its identity check (K2: the file token, staged_at, start_id, teardown_id) included.
// K3 and K4 are effects, never answers: every operation goes on to its own rule on the record they leave.
//
// Capacity is counted by confirmation: a slot not granted counts until its held_until (staged_until, then
// deadline_at); S4's start is its grant (granted_at, the Store's time), from which it counts until S8 deletes it or
// HARD_HOLD_MS after granted_at. Time never frees a granted slot earlier, and no other transaction removes a processing
// slot: DELETE, the sweep and K3 leave it.
//
// Only durations cross a clock boundary: S1 takes the route's remaining v1 time (v1Left) and answers the staging time
// left, S4 the job's time left, S5 a grant, each counted by the caller from its own reading taken before the call.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// ---- Constants (the plan's section 3, "Constants (PR4-1)", from design 4.7 and 4.11 and the stage p95s of P27)

const T_DISPATCH = 2 * SECOND;
const T_START = 3 * SECOND;
// The input streamed into the container: its size at INPUT_BYTES_PER_SECOND, at least T_INPUT_MIN.
const INPUT_BYTES_PER_SECOND = 25 * 1024 * 1024;
const T_INPUT_MIN = SECOND;
const T_PROBE = SECOND;
// The container's still, which /normalize holds out of the encode's cut.
const T_STILL = SECOND;
// The Workers-side preview: Images' WebP and the RGBA_MIN_CALL_MS stillPreview keeps for the blurhash.
const T_PREVIEW = 3 * SECOND;
// The output into R2, the confirmed stop, three S5 calls and writes, and S6.
const T_COMMIT = 6 * SECOND;
// Sending S10 and its answer (v1).
export const T_REPLY = 2 * SECOND;
export const T_MIN_ENCODE = 5 * SECOND;
// W1's bound: a grant covers starting one write.
export const AV_GRANT_MS = 2 * SECOND;
export const V2_PROCESS_MS = 8 * MINUTE;
const AV_UPLOAD_LIMIT = 94_371_840;
export const STAGING_MS = 10 * MINUTE;
export const DISPATCH_MS = 2 * MINUTE;
export const MAX_AV_INFLIGHT = 2;
export const DISPATCH_BATCH = 50;
// How long a granted slot counts at most (D16, D17).
export const HARD_HOLD_MS = 24 * HOUR;
// The incoming/ orphan pass: at most one claim an hour, and a key older than INCOMING_ORPHAN_AGE_MS that no row holds.
const INCOMING_SWEEP_MS = HOUR;
export const INCOMING_ORPHAN_AGE_MS = 24 * HOUR;
// The most keys one classification reads (one R2 list page).
const INCOMING_PAGE_KEYS = 1000;

// The causes a failed row records: the processor's (S7) and the Store's own (K3 `restored`, K4 `deadline`, S4's
// early `timeout`), as migration 0121's CHECK lists them.
const PROCESSOR_FAILURES = ["refused", "envelope", "verifier", "unavailable", "timeout"] as const;
export type ProcessorFailure = (typeof PROCESSOR_FAILURES)[number];
export type Failure = ProcessorFailure | "deadline" | "restored";

// ---- The allocation (design 4.7)

export type Endpoint = "v1" | "v2";
const STAGES = ["dispatch", "start", "input", "probe", "encode", "still", "preview", "commit"] as const;
export type Stage = (typeof STAGES)[number];

export function inputMs(inputBytes: number): number {
  return Math.max(T_INPUT_MIN, Math.ceil((inputBytes / INPUT_BYTES_PER_SECOND) * SECOND));
}

// The fixed part of each stage; the encode has none (it takes what is left).
function fixedOf(stage: Stage, inputBytes: number): number {
  switch (stage) {
    case "dispatch":
      return T_DISPATCH;
    case "start":
      return T_START;
    case "input":
      return inputMs(inputBytes);
    case "probe":
      return T_PROBE;
    case "encode":
      return 0;
    case "still":
      return T_STILL;
    case "preview":
      return T_PREVIEW;
    case "commit":
      return T_COMMIT;
  }
}

export type Allocation = {
  endpoint: Endpoint;
  inputBytes: number;
  // The job's deadline_at: `until` less T_REPLY for v1.
  deadline: number;
  // T_FIXED(endpoint, size): every stage's fixed part, and T_REPLY for v1.
  fixedMs: number;
  // Each stage's cut: the deadline less the fixed parts of the stages after it. A stage that begins later than planned
  // takes from the encode, never from a later stage (soft cuts, recomputed when each stage begins: encodeLeft).
  cuts: Record<Stage, number>;
  // The encode time left when the dispatch begins at `from`.
  encodeMs: number;
};

// Divides the time from `from` to `until` (v1: reply_by; v2: the processing's end) into the stages of an upload of
// `inputBytes`. One function serves the queue's admission (S3), the start (S4) and the processor's stage cuts.
export function allocate(endpoint: Endpoint, from: number, until: number, inputBytes: number): Allocation {
  const deadline = until - (endpoint === "v1" ? T_REPLY : 0);
  let after = 0;
  const cuts = {} as Record<Stage, number>;
  for (const stage of STAGES.toReversed()) {
    cuts[stage] = deadline - after;
    after += fixedOf(stage, inputBytes);
  }
  const fixedMs = after + (endpoint === "v1" ? T_REPLY : 0);
  const allocation = { endpoint, inputBytes, deadline, fixedMs, cuts, encodeMs: 0 };
  return { ...allocation, encodeMs: encodeLeft(allocation, from, "dispatch") };
}

// The encode time left when `stage` (one before the encode, or the encode itself) begins at `at`: the encode's cut
// less `at` and the fixed parts of the stages from `stage` to the probe.
export function encodeLeft(allocation: Omit<Allocation, "encodeMs">, at: number, stage: Stage): number {
  const index = STAGES.indexOf(stage);
  const encode = STAGES.indexOf("encode");
  let before = 0;
  for (const s of STAGES.slice(index, Math.max(index, encode))) {
    before += fixedOf(s, allocation.inputBytes);
  }
  return allocation.cuts.encode - at - before;
}

// What is left of a duration `ms` answered to a call sent at `readBefore` (the caller's reading taken before the
// call), at the caller's `now`: a late reply only shortens it.
export function remainingOf(readBefore: number, ms: number, now: number): number {
  return readBefore + ms - now;
}

// ---- The record

type Attachment = {
  id: string;
  account_id: string;
  file_token: string | null;
  processed: number;
  url: string;
  type: string;
  created_at: string;
  gc_at: string | null;
  scheduled_status_id: string | null;
};

// A processing row as migration 0121's CHECKs hold each state to its columns.
type RowBase = { staged_at: number; staged_until: number; reply_by: number | null };
type ProcessingRow =
  | (RowBase & {
      state: "staging";
      deadline_at: null;
      input_bytes: null;
      start_id: null;
      started_by: null;
      failure: null;
    })
  | (RowBase & {
      state: "pending";
      deadline_at: number;
      input_bytes: number;
      start_id: null;
      started_by: null;
      failure: null;
    })
  | (RowBase & {
      state: "running";
      deadline_at: number;
      input_bytes: number;
      start_id: string;
      started_by: string;
      failure: null;
    })
  | (RowBase & {
      state: "failed";
      deadline_at: number;
      input_bytes: number;
      start_id: string | null;
      started_by: string | null;
      failure: Failure;
    });

type Slot = {
  phase: "staging" | "processing";
  teardown_id: string | null;
  granted_at: number | null;
};

type UploadRecord = { att: Attachment | null; row: ProcessingRow | null; slot: Slot | null };

function load(db: Db, id: string): UploadRecord {
  const att =
    db.first<Attachment>(
      `SELECT id, account_id, file_token, processed, url, type, created_at, gc_at, scheduled_status_id
		FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX} WHERE id = ?`,
      id,
    ) ?? null;
  const row =
    db.first<ProcessingRow>(
      `SELECT state, staged_at, staged_until, deadline_at, reply_by, start_id, started_by, input_bytes, failure
			FROM media_processing WHERE media_id = ?`,
      id,
    ) ?? null;
  const slot =
    db.first<Slot>("SELECT phase, teardown_id, granted_at FROM media_av_slots WHERE media_id = ?", id) ?? null;
  return { att, row, slot };
}

// The attachment as the operations see it, for the reservation `token` names (undefined: any token).
//   none    no row, or another reservation's
//   res     reserved, unfinished (processed = 0)
//   done    completed (processed = 1 with its URL)
//   doomed  deleted or doomed (gc_at DOOMED_AT), or abandoned (processed = 1 without a URL)
type AttachmentState = "none" | "res" | "done" | "doomed";

function attachmentState(att: Attachment | null, token?: string): AttachmentState {
  if (att === null || att.file_token === null || (token !== undefined && att.file_token !== token)) {
    return "none";
  }
  if (att.gc_at === DOOMED_AT || (att.processed === 1 && att.url === "")) {
    return "doomed";
  }
  return att.processed === 1 ? "done" : "res";
}

// Whether the reservation was made as an AV candidate (reserveMedia's avCandidate, stamped at the Store's time) and
// has not been staged: S1 sets its type from the input's signature, so a reservation is staged once at most.
function candidate(att: Attachment): boolean {
  return att.type === AV_CANDIDATE_TYPE;
}

// Whether S1 chose the AV path for the reservation: it set the provisional type, video or audio.
function onAvPath(att: Attachment): boolean {
  return att.type === "video" || att.type === "audio";
}

// Whether the reservation is on the AV path or may still take it (a candidate): S11's unfinished reservation. One the
// image path took (startTransforms set image) is left to deleteMedia's rules, as any image upload.
function avReservation(att: Attachment): boolean {
  return candidate(att) || onAvPath(att);
}

// The attachment as S4, S7, S9 and S10 see it: one the image path took (startTransforms set image) is not theirs, the
// same as none, so they never answer for it or doom it.
function avAttachment(att: Attachment | null): Attachment | null {
  return att !== null && avReservation(att) ? att : null;
}

// K3's fence: the attachment was reserved at or before the last restore. Asked only where K3 decides the answer or the
// write, so the marker is read (and an unknown one refuses) only there (restoreTime).
function fenced(att: Attachment | null, restoredAt: Marker): boolean {
  if (att === null) {
    return false;
  }
  const at = restoreTime(restoredAt);
  return at !== null && Date.parse(att.created_at) <= at;
}

function deleteRow(db: Db, id: string): void {
  db.run("DELETE FROM media_processing WHERE media_id = ?", id);
}

function deleteSlot(db: Db, id: string): void {
  db.run("DELETE FROM media_av_slots WHERE media_id = ?", id);
}

function fail(db: Db, id: string, cause: Failure): void {
  db.run(
    "UPDATE media_processing SET state = 'failed', failure = ?, dispatched_at = NULL WHERE media_id = ?",
    cause,
    id,
  );
}

// The upload is doomed: its processing row deleted and its attachment's gc_at DOOMED_AT, so every later operation
// meets it at its identity check and the sweep deletes it and its keys. Its slot is kept.
function doom(db: Db, id: string): void {
  deleteRow(db, id);
  db.run("UPDATE media_attachments SET gc_at = ? WHERE id = ? AND status_id IS NULL", DOOMED_AT, id);
}

// K3, else K4, on the upload's record: at most one applies, since K3 leaves no row pending or running for K4.
type Effect = "k3-staging" | "k3-restored" | "k4-doom" | "k4-deadline";

// K3 acts only on a staging, pending or running row, so the marker is asked for only there: a completed, failed or
// absent row is decided whatever it says.
function effectOf(record: UploadRecord, now: number, restoredAt: Marker): Effect | null {
  const { att, row } = record;
  if (row === null || row.state === "failed") {
    return null;
  }
  if (fenced(att, restoredAt)) {
    if (row.state === "staging") {
      return "k3-staging";
    }
    if (row.state === "pending" || row.state === "running") {
      return "k3-restored";
    }
  }
  if ((row.state === "pending" || row.state === "running") && now >= row.deadline_at) {
    return row.reply_by !== null ? "k4-doom" : "k4-deadline";
  }
  return null;
}

// Writes `effect` on the record already loaded, and answers the record after it.
function apply(db: Db, id: string, record: UploadRecord, effect: Effect | null): UploadRecord {
  if (effect === null) {
    return record;
  }
  if (effect === "k3-staging") {
    deleteRow(db, id);
    if (record.slot?.phase === "staging") {
      deleteSlot(db, id);
    }
  } else if (effect === "k3-restored") {
    fail(db, id, "restored");
  } else if (effect === "k4-doom") {
    doom(db, id);
  } else {
    fail(db, id, "deadline");
  }
  return load(db, id);
}

// K3 and K4 on the upload's record, written: a read computes them without writing (normalized).
function normalize(db: Db, id: string, now: number, restoredAt: Marker): UploadRecord {
  const record = load(db, id);
  return apply(db, id, record, effectOf(record, now, restoredAt));
}

// The processing state K3 and K4 would leave on the record, written nowhere (S9, the owner's GET and PUT): the row's
// own, null where they delete the row (K3 on a staging row, K4's doom), or failed (K3's `restored`, K4's `deadline`,
// which leave the attachment as it is).
function normalizedState(record: UploadRecord, now: number, restoredAt: Marker): ProcessingRow["state"] | null {
  const effect = effectOf(record, now, restoredAt);
  if (record.row === null || effect === null) {
    return record.row?.state ?? null;
  }
  return effect === "k3-staging" || effect === "k4-doom" ? null : "failed";
}

// ---- Activation and capacity

// What the Worker knows of activation: the processor's binding, MEDIA_UPLOAD_MONTHLY_JOBS and its own build.
export type ActivationInput = { binding: boolean; budget: number; build: string };

// Uploads are active with the binding, a positive budget and a passed probe of NORMALIZE_PROFILE for the build. A
// spent positive budget is still active (it answers `spent`).
function isActive(db: Db, activation: ActivationInput, now: number): boolean {
  return (
    activation.binding &&
    Number.isSafeInteger(activation.budget) &&
    activation.budget > 0 &&
    probePassed(db, NORMALIZE_PROFILE, activation.build, now)
  );
}

// The slots that count at `now`, read up to MAX_AV_INFLIGHT + 1: each part one range of its partial index.
function countingSlots(db: Db, now: number): number {
  return (
    db.first<{ n: number }>(
      `SELECT (SELECT count(*) FROM (SELECT 1 FROM media_av_slots INDEXED BY media_av_slots_held
				WHERE granted_at IS NULL AND held_until > ?1 LIMIT ?3))
			+ (SELECT count(*) FROM (SELECT 1 FROM media_av_slots INDEXED BY media_av_slots_granted
				WHERE granted_at IS NOT NULL AND granted_at > ?2 LIMIT ?3)) AS n`,
      now,
      now - HARD_HOLD_MS,
      MAX_AV_INFLIGHT + 1,
    )?.n ?? 0
  );
}

export type AvActivation = {
  active: boolean;
  binding: boolean;
  budget: number;
  // Upload units spent in the Store's month.
  spent: number;
  // The slots that count now, at most MAX_AV_INFLIGHT + 1.
  slots: number;
  probe: ProbeState;
};

// Activation as the Store reads it at its own time (health, the instance endpoints; S1, S3 and reserveMedia read the
// same in their own transactions).
export const avActivation = readOperation.atStoreTime("now")<ActivationInput & { now: number }, AvActivation>(
  (db, { now, ...activation }) => ({
    active: isActive(db, activation, now),
    binding: activation.binding,
    budget: activation.budget,
    spent: uploadJobsSpent(db, now),
    slots: countingSlots(db, now),
    probe: probeState(db, NORMALIZE_PROFILE, now),
  }),
);

// ---- Inputs

type Fence = { now: number; restoredAt: Marker };

const ID_BYTES = 64;
const IDENTITY = /^[\x21-\x7e]{1,64}$/;

function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > ID_BYTES) {
    throw new Error("not a media id");
  }
}

function identity(value: unknown): value is string {
  return typeof value === "string" && IDENTITY.test(value);
}

// ---- S1 takeAvSlot

export type AvKind = "video" | "audio";

export type TakeAvSlot =
  // The staging row and slot: its identity (stagedAt) and the staging time left, a duration.
  | { status: "taken"; stagedAt: number; stagingMs: number }
  | { status: "gone" }
  | { status: "time" }
  | { status: "inactive" }
  | { status: "busy" }
  | { status: "spent" };

// S1, at the sniff: takes a staging slot for the reservation `id` (its file token `token`), sets its provisional
// type from the signature (the staged mark: S1 never stages a reservation twice), and answers the staging time.
// `v1Left`: the route's remaining v1 time, V1_TIME_MS less the time since arrival on its clock; null for v2.
export const takeAvSlot = writeOperation.atStoreTime("now")<
  { id: string; token: string; kind: AvKind; v1Left: number | null; activation: ActivationInput } & Fence,
  TakeAvSlot
>((db, { id, token, kind, v1Left, activation, now, restoredAt }) => {
  checkId(id);
  if (kind !== "video" && kind !== "audio") {
    throw new Error("not a video or audio kind");
  }
  const record = normalize(db, id, now, restoredAt);
  const { att, row } = record;
  if (att === null || attachmentState(att, token) !== "res") {
    return { status: "gone" };
  }
  if (row?.state === "staging") {
    return { status: "taken", stagedAt: row.staged_at, stagingMs: row.staged_until - now };
  }
  if (!candidate(att) || fenced(att, restoredAt)) {
    return { status: "gone" };
  }
  const left = v1Left === null ? null : Number.isSafeInteger(v1Left) ? v1Left : 0;
  if ((left !== null && left <= T_REPLY) || now >= Date.parse(att.created_at) + WRITE_WINDOW_MS) {
    return { status: "time" };
  }
  if (!isActive(db, activation, now)) {
    return { status: "inactive" };
  }
  if (countingSlots(db, now) >= MAX_AV_INFLIGHT) {
    return { status: "busy" };
  }
  if (!uploadJobFits(db, activation.budget, now)) {
    return { status: "spent" };
  }
  const replyBy = left === null ? null : now + left;
  const until = replyBy === null ? now + STAGING_MS : Math.min(now + STAGING_MS, replyBy - T_REPLY);
  db.run(
    "INSERT INTO media_processing (media_id, state, staged_at, staged_until, reply_by) VALUES (?, 'staging', ?, ?, ?)",
    id,
    now,
    until,
    replyBy,
  );
  db.run("INSERT INTO media_av_slots (media_id, phase, held_until) VALUES (?, 'staging', ?)", id, until);
  db.run("UPDATE media_attachments SET type = ? WHERE id = ?", kind, id);
  return { status: "taken", stagedAt: now, stagingMs: until - now };
});

// ---- S2 releaseStaging

// S2, every staging exit of the route: deletes the staging row of that stagedAt and its slot (`released`: the input is
// the route's to delete); anything else changes nothing of the row (`not_staging`: the input waits for the sweep).
export const releaseStaging = writeOperation.atStoreTime("now")<
  { id: string; token: string; stagedAt: number } & Fence,
  { status: "released" } | { status: "not_staging" }
>((db, { id, token, stagedAt, now, restoredAt }) => {
  checkId(id);
  const { att, row } = normalize(db, id, now, restoredAt);
  if (attachmentState(att, token) !== "none" && row?.state === "staging" && row.staged_at === stagedAt) {
    deleteRow(db, id);
    deleteSlot(db, id);
    return { status: "released" };
  }
  return { status: "not_staging" };
});

// ---- S3 queueNormalize

export type QueueRefusal = "restored" | "staging_deadline" | "inactive" | "spent" | "time";

export type QueueNormalize =
  | { status: "queued"; teardownId: string }
  | { status: "settled"; outcome: "running" | "completed" | { failed: Failure } }
  // The row and slot are deleted in this transaction: the input is the route's to delete.
  | { status: "refused_cleanup_yours"; reason: QueueRefusal }
  | { status: "gone" };

export type UploadText = { description: string; focus: { x: number; y: number } | undefined };

// S3, before any 2xx: queues the staging upload of that stagedAt. Every deadline comes from one allocation; the upload
// unit is charged once here; the text is stored on the attachment; the slot moves to processing with a teardown_id
// drawn here, which S8 alone accepts. A repeat finds the row pending (`queued`, nothing charged) or settled.
export const queueNormalize = writeOperation.atStoreTime("now")<
  {
    id: string;
    token: string;
    stagedAt: number;
    bytes: number;
    text: UploadText;
    activation: ActivationInput;
  } & Fence,
  QueueNormalize
>((db, { id, token, stagedAt, bytes, text, activation, now, restoredAt }) => {
  checkId(id);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AV_UPLOAD_LIMIT) {
    throw new Error("input bytes out of bounds");
  }
  const before = load(db, id);
  const mine = attachmentState(before.att, token) !== "none";
  const restoredStaging =
    mine && before.row?.state === "staging" && before.row.staged_at === stagedAt && fenced(before.att, restoredAt);
  const { att, row, slot } = apply(db, id, before, effectOf(before, now, restoredAt));
  if (restoredStaging) {
    return { status: "refused_cleanup_yours", reason: "restored" };
  }
  if (!mine || att === null) {
    return { status: "gone" };
  }
  if (row?.state === "staging" && row.staged_at === stagedAt) {
    const refused = (reason: QueueRefusal): QueueNormalize => {
      deleteRow(db, id);
      deleteSlot(db, id);
      return { status: "refused_cleanup_yours", reason };
    };
    if (now >= row.staged_until) {
      return refused("staging_deadline");
    }
    if (!isActive(db, activation, now)) {
      return refused("inactive");
    }
    if (!uploadJobFits(db, activation.budget, now)) {
      return refused("spent");
    }
    const endpoint: Endpoint = row.reply_by !== null ? "v1" : "v2";
    // The AV write deadline (the spec's QueueDeadline): deadline_at, the commit's cut, never passes it, and allocate
    // takes the stages after the encode, which make the writes, before it once.
    const cap = Date.parse(att.created_at) + AV_WRITE_WINDOW_MS;
    const until = Math.min(row.reply_by ?? now + V2_PROCESS_MS, cap + (endpoint === "v1" ? T_REPLY : 0));
    const allocation = allocate(endpoint, now, until, bytes);
    if (allocation.encodeMs < T_MIN_ENCODE) {
      return refused("time");
    }
    chargeUploadJob(db, activation.budget, now);
    db.run(
      `UPDATE media_processing SET state = 'pending', queued_at = ?, dispatched_at = ?, deadline_at = ?, input_bytes = ?
			WHERE media_id = ?`,
      now,
      now,
      allocation.deadline,
      bytes,
      id,
    );
    const teardownId = crypto.randomUUID();
    db.run(
      `INSERT OR REPLACE INTO media_av_slots (media_id, phase, held_until, teardown_id, granted_at)
			VALUES (?, 'processing', ?, ?, NULL)`,
      id,
      allocation.deadline,
      teardownId,
    );
    db.run(
      "UPDATE media_attachments SET description = ?, focus_x = ?, focus_y = ?, focus_given = ? WHERE id = ?",
      storedMediaDescription(text.description),
      text.focus?.x ?? 0,
      text.focus?.y ?? 0,
      text.focus === undefined ? 0 : 1,
      id,
    );
    return { status: "queued", teardownId };
  }
  if (row?.state === "pending") {
    return slot?.teardown_id ? { status: "queued", teardownId: slot.teardown_id } : { status: "gone" };
  }
  if (row?.state === "running") {
    return { status: "settled", outcome: "running" };
  }
  if (row?.state === "failed") {
    return { status: "settled", outcome: { failed: row.failure } };
  }
  if (row === null && attachmentState(att, token) === "done" && onAvPath(att)) {
    return { status: "settled", outcome: "completed" };
  }
  return { status: "gone" };
});

// ---- S4 startNormalize

export type StartNormalize =
  // msLeft: the time to the job's deadline_at, a duration; endpoint and inputBytes for the processor's allocation.
  | { status: "started"; startId: string; msLeft: number; inputBytes: number; endpoint: Endpoint }
  | { status: "settled"; state: "running" | "completed" | { failed: Failure } }
  | { status: "gone" };

// S4, the start rule: a pending job starts once, by the invocation that asks first, while T_MIN_ENCODE is left after
// the remaining fixed parts (else it fails `timeout`). The start is the slot's grant (granted_at, the Store's time,
// stored whatever becomes of the reply). The same invocation asking again gets the same start_id; any other is told the
// state, which grants nothing.
export const startNormalize = writeOperation.atStoreTime("now")<
  { id: string; token: string; invocation: string } & Fence,
  StartNormalize
>((db, { id, token, invocation, now, restoredAt }) => {
  checkId(id);
  if (!identity(invocation)) {
    throw new Error("not an invocation id");
  }
  const { att: loaded, row, slot } = normalize(db, id, now, restoredAt);
  const att = avAttachment(loaded);
  const mine = attachmentState(att, token) !== "none";
  if (mine && row?.state === "pending") {
    const endpoint: Endpoint = row.reply_by !== null ? "v1" : "v2";
    const allocation = allocate(endpoint, now, row.deadline_at + (endpoint === "v1" ? T_REPLY : 0), row.input_bytes);
    if (encodeLeft(allocation, now, "start") < T_MIN_ENCODE) {
      fail(db, id, "timeout");
      return { status: "settled", state: { failed: "timeout" } };
    }
    const startId = crypto.randomUUID();
    db.run(
      "UPDATE media_processing SET state = 'running', start_id = ?, started_by = ?, dispatched_at = NULL WHERE media_id = ?",
      startId,
      invocation,
      id,
    );
    if (slot?.phase === "processing" && slot.granted_at === null) {
      db.run("UPDATE media_av_slots SET granted_at = ? WHERE media_id = ?", now, id);
    }
    return { status: "started", startId, msLeft: row.deadline_at - now, inputBytes: row.input_bytes, endpoint };
  }
  if (mine && row?.state === "running" && row.started_by === invocation) {
    return {
      status: "started",
      startId: row.start_id,
      msLeft: row.deadline_at - now,
      inputBytes: row.input_bytes,
      endpoint: row.reply_by !== null ? "v1" : "v2",
    };
  }
  return settledOf(att, row, token);
});

function settledOf(att: Attachment | null, row: ProcessingRow | null, token: string): StartNormalize {
  if (attachmentState(att, token) === "none") {
    return { status: "gone" };
  }
  if (row?.state === "running") {
    return { status: "settled", state: "running" };
  }
  if (row?.state === "failed") {
    return { status: "settled", state: { failed: row.failure } };
  }
  if (row === null && attachmentState(att, token) === "done") {
    return { status: "settled", state: "completed" };
  }
  return { status: "gone" };
}

// ---- S5 confirmAvWrite

export type AvWrite = "original" | "full" | "small";

// S5, before each final write: a grant of min(AV_GRANT_MS, deadline_at - now), a duration, while the job runs under
// that start_id before its deadline; else `refused`. One write a grant.
export const confirmAvWrite = writeOperation.atStoreTime("now")<
  { id: string; startId: string; write: AvWrite } & Fence,
  { status: "grant"; ms: number } | { status: "refused" }
>((db, { id, startId, write, now, restoredAt }) => {
  checkId(id);
  if (write !== "original" && write !== "full" && write !== "small") {
    throw new Error("not a write");
  }
  // K4 has failed or doomed a row at its deadline_at, so a running row here is before it.
  const { row } = normalize(db, id, now, restoredAt);
  if (row?.state === "running" && row.start_id === startId) {
    return { status: "grant", ms: Math.min(AV_GRANT_MS, row.deadline_at - now) };
  }
  return { status: "refused" };
});

// ---- S6 completeAvUpload

// The verified facts of the full file, as the processor's output verifier states them (src/platform/av-bytes.ts), and
// the WebP preview's, or none.
export type AvFacts = (
  | ({ contentType: "video/mp4" } & Pick<
      VideoFacts,
      "kind" | "width" | "height" | "frameRate" | "duration" | "bitrate" | "bytes"
    >)
  | ({ contentType: "audio/mpeg" } & Pick<AudioFacts, "kind" | "duration" | "bitrate" | "bytes">)
) & { preview: { width: number; height: number; blurhash: string | null } | null };

function edge(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 65_535;
}

// The meta a completed upload stores (design 4.13's keys), the verifier's values as it computed them: video original
// {width, height, frame_rate, duration, bitrate} and small {width, height} with a preview; audio original {duration,
// bitrate}. Throws on facts that are not the verifier's shape.
function avMeta(facts: AvFacts): string | null {
  const { kind, contentType, bytes, duration, bitrate, preview } = facts;
  const typed = (kind === "video" && contentType === "video/mp4") || (kind === "audio" && contentType === "audio/mpeg");
  if (
    !typed ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(bitrate) ||
    bitrate < 0
  ) {
    throw new Error("not verified facts");
  }
  if (facts.kind === "audio") {
    if (preview !== null) {
      throw new Error("an audio upload has no preview");
    }
    return storedMediaMeta(JSON.stringify({ original: { duration, bitrate } }));
  }
  const { width, height, frameRate } = facts;
  if (!edge(width) || !edge(height) || !isFrameRate(frameRate)) {
    throw new Error("not verified video facts");
  }
  if (preview !== null && (!edge(preview.width) || !edge(preview.height))) {
    throw new Error("not a preview's geometry");
  }
  const original = { width, height, frame_rate: frameRate, duration, bitrate };
  return storedMediaMeta(
    JSON.stringify(
      preview === null ? { original } : { original, small: { width: preview.width, height: preview.height } },
    ),
  );
}

// S6, once every write has landed: the job running under that start_id before its deadline completes with its own
// facts (type, content type, URL from the full type, preview_url small.webp or NULL, meta, blurhash), processed = 1
// and the unattached gc_at, and its processing row deleted; the description and focus are left as they are. A repeat
// of the same reservation completed and not doomed answers `done`; anything else `refused`. It never revives a doomed
// row (a doomed upload has no processing row).
export const completeAvUpload = writeOperation.atStoreTime("now")<
  { id: string; token: string; startId: string; facts: AvFacts } & Fence,
  { status: "done" } | { status: "refused" }
>((db, { id, token, startId, facts, now, restoredAt }) => {
  checkId(id);
  const meta = avMeta(facts);
  const { att, row } = normalize(db, id, now, restoredAt);
  const mine = attachmentState(att, token);
  if (mine === "res" && row?.state === "running" && row.start_id === startId) {
    const uri = ownerUri(db, id);
    if (uri === undefined) {
      return { status: "refused" };
    }
    const origin = new URL(uri).origin;
    db.run(
      `UPDATE media_attachments SET type = ?, content_type = ?, url = ?, preview_url = ?, meta = ?, blurhash = ?,
				processed = 1, gc_at = ?
			WHERE id = ? AND processed = 0 AND gc_at IS NOT ?`,
      facts.kind,
      facts.contentType,
      mediaUrl(origin, token, "full", facts.contentType),
      facts.preview === null ? null : mediaUrl(origin, token, "small", "image/webp"),
      meta,
      facts.preview === null ? null : storedBlurhash(facts.preview.blurhash),
      iso(now + DETACHED_GRACE_MS),
      id,
      DOOMED_AT,
    );
    deleteRow(db, id);
    return { status: "done" };
  }
  return mine === "done" && row === null && att !== null && onAvPath(att) ? { status: "done" } : { status: "refused" };
});

// ---- S7 failNormalize

// S7: the job running under that start_id fails with the processor's cause; past deadline_at K4 has recorded
// `deadline` (or doomed a v1 upload) first. A repeat answers the recorded cause.
export const failNormalize = writeOperation.atStoreTime("now")<
  { id: string; startId: string; cause: ProcessorFailure } & Fence,
  { status: "recorded"; cause: Failure } | { status: "settled"; state: "completed" } | { status: "gone" }
>((db, { id, startId, cause, now, restoredAt }) => {
  checkId(id);
  if (!PROCESSOR_FAILURES.includes(cause)) {
    throw new Error("not a processor failure");
  }
  const { att, row } = normalize(db, id, now, restoredAt);
  if (row?.state === "running" && row.start_id === startId) {
    fail(db, id, cause);
    return { status: "recorded", cause };
  }
  if (row?.state === "failed") {
    return { status: "recorded", cause: row.failure };
  }
  if (row === null && attachmentState(avAttachment(att)) === "done") {
    return { status: "settled", state: "completed" };
  }
  return { status: "gone" };
});

// ---- S8 releaseAvSlot

// S8, the stop confirmation: the processor calls it only once its container is confirmed stopped, with the
// teardown_id its record holds. It deletes the slot of that teardown_id unless the row is still pending (`held`); a
// slot of another teardown_id, or none, is left as it is (`released`, so a repeat converges).
export const releaseAvSlot = writeOperation.atStoreTime("now")<
  { id: string; teardownId: string } & Fence,
  { status: "released" } | { status: "held" }
>((db, { id, teardownId, now, restoredAt }) => {
  checkId(id);
  const { row, slot } = normalize(db, id, now, restoredAt);
  if (slot?.phase !== "processing" || slot.teardown_id === null || slot.teardown_id !== teardownId) {
    return { status: "released" };
  }
  if (row?.state === "pending") {
    return { status: "held" };
  }
  deleteSlot(db, id);
  return { status: "released" };
});

// ---- S9 v1Outcome

// S9, the v1 route's poll (a read): `done` for a completed upload, `processing` while unfinished, `ended` otherwise
// (failed, doomed, gone), as K3 and K4 would leave the record at the Store's time. Only a reservation of that token
// staging, or pending or running before its deadline_at, asks for the marker: K3 ends it, where every other record
// answers alike whatever K3 says (a pending or running row at its deadline_at ends by K3 or by K4).
export const v1Outcome = readOperation.atStoreTime("now")<
  { id: string; token: string } & Fence,
  { status: "done" | "processing" | "ended" }
>((db, { id, token, now, restoredAt }) => {
  checkId(id);
  const record = load(db, id);
  const kind = attachmentState(avAttachment(record.att), token);
  if (kind === "done") {
    return { status: "done" };
  }
  const before = record.row;
  if (
    kind === "none" ||
    before === null ||
    before.state === "failed" ||
    (before.state !== "staging" && now >= before.deadline_at)
  ) {
    return { status: "ended" };
  }
  const state = normalizedState(record, now, restoredAt);
  return state === "staging" || state === "pending" || state === "running"
    ? { status: "processing" }
    : { status: "ended" };
});

// ---- S10 v1Final

export type V1Final = { status: 200; media: MediaAttachment } | { status: 422 | 500 | 503 } | { status: "maintenance" };

function httpOf(cause: Failure): 422 | 500 | 503 {
  if (cause === "refused" || cause === "envelope") {
    return 422;
  }
  return cause === "verifier" || cause === "unavailable" || cause === "timeout" ? 500 : 503;
}

// The attachment as its owner is shown it, by the presenter every owner's answer uses (GET, PUT, S10's 200): on the
// instance origin, which a video without a still needs for VIDEO_POSTER (status-presenter.ts playablePreview), read
// only for a playable one.
function presentRow(db: Db, row: MediaRow): MediaAttachment {
  return presentMedia(row, isPlayable(row.type) ? instanceOrigin(db) : null);
}

// A completed upload before its gc_at, presented; null otherwise (main reads a row past gc_at as gone).
function liveDone(db: Db, att: Attachment | null, token: string, now: number): MediaAttachment | null {
  if (att === null || attachmentState(att, token) !== "done" || (att.gc_at !== null && att.gc_at <= iso(now))) {
    return null;
  }
  const row = db.first<MediaRow>(
    `SELECT ${selectSql(MEDIA_COLUMN_MAP)} FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX} WHERE m.id = ?`,
    att.id,
  );
  return row === undefined ? null : presentRow(db, row);
}

// S10, the v1 decision, made at the route's own cut or once S9 shows an outcome: 200 for a completed upload before
// its gc_at; 503, changing nothing, for one from its gc_at on; the failure's answer for a failed one (422 for the input,
// 500 for the processing); and otherwise 503 with the upload doomed (unfinished, failed `deadline` or `restored`, Q4),
// whatever its deadline_at says. A reservation of that token pending or running is doomed without the marker: K3 fails it
// `restored`, K4 dooms it or fails it `deadline`, and S10 dooms each the same, so every K3 outcome answers 503 with the
// processing row deleted, gc_at DOOMED_AT and the slot kept. A staging one asks (K3 deletes its staging slot, which a
// doom keeps), as does another token's record (K3 and K4 write on it).
export const v1Final = writeOperation.atStoreTime("now")<{ id: string; token: string } & Fence, V1Final>((
  db,
  { id, token, now, restoredAt },
) => {
  checkId(id);
  const record = load(db, id);
  if (
    attachmentState(avAttachment(record.att), token) === "res" &&
    (record.row?.state === "pending" || record.row?.state === "running")
  ) {
    doom(db, id);
    return { status: 503 };
  }
  const { att: loaded, row } = apply(db, id, record, effectOf(record, now, restoredAt));
  const att = avAttachment(loaded);
  const media = liveDone(db, att, token, now);
  if (media !== null) {
    return { status: 200, media };
  }
  const kind = attachmentState(att, token);
  if (kind === "done") {
    return { status: 503 };
  }
  if (kind === "res" && row?.state === "failed" && httpOf(row.failure) !== 503) {
    return { status: httpOf(row.failure) };
  }
  if (kind === "res") {
    doom(db, id);
  }
  return { status: 503 };
});

// S10 while the Store refuses writes: a read. A completed upload before its gc_at answers 200; anything else
// `maintenance`, with nothing doomed (K4 dooms it at its deadline once maintenance ends).
// It reads no marker: K3 and K4 act only on an upload with a processing row, which is never a completed one.
export const v1FinalRead = readOperation.atStoreTime("now")<
  { id: string; token: string; now: number },
  { status: 200; media: MediaAttachment } | { status: "maintenance" }
>((db, { id, token, now }) => {
  checkId(id);
  const { att } = load(db, id);
  const media = liveDone(db, avAttachment(att), token, now);
  return media === null ? { status: "maintenance" } : { status: 200, media };
});

// ---- S11 deleteAvUpload

// S11, the owner's DELETE of an upload (the spec's S11 after Norm). An unfinished reservation on the AV path that is
// the owner's and unattached (a status cannot hold one: the CHECK status_id IS NULL OR processed = 1; a scheduled
// status's hold is the application's, so it is checked), and not staging, is doomed, its processing row deleted if it
// has one and its slot kept; a staging one is not found (its request still holds it). Anything else is decided by
// deleteMedia's rules (media.ts deleteOwnMedia): a completed upload is in use while attached or kept, not found from
// its gc_at on, and a doomed or absent one is not found.
// Ownership is read first, as on the owner's DELETE (deleteOwnerMedia): the marker only where K3 changes the answer.
export const deleteAvUpload = userMediaDeleteOperation.atStoreTime("now")<
  { id: string; now: number; restoredAt: Marker },
  MediaDeleted
>((db, { id, now, restoredAt }, { accountId }) => {
  checkId(id);
  return deleteUpload(db, accountId, id, now, restoredAt);
});

// S11 on the upload `id`, its ownership read before K3 and K4, so another account's record is never normalized: one
// without a processing row by deleteMedia's rules, from the facts already read (the attachment's row itself is read
// once, by ownUpload, as before #1828). An unattached reservation pending or running is doomed without the marker
// unless it is a v1 one at its deadline_at: K3 fails it `restored` and S11 dooms it, as it dooms it unfenced, so both
// answer `deleted` with the same rows; a v1 one K4 has doomed is not found, so there K3 decides. A staging one asks
// too (K3 deletes it, and S11 then dooms the reservation).
function deleteUpload(db: Db, accountId: string, id: string, now: number, restoredAt: Marker): MediaDeleted {
  const own = ownerFacts(db, accountId, id, now);
  if (own === undefined) {
    return "not_found";
  }
  // An AV reservation never staged has no processing row either: S11 dooms it below.
  const reservation =
    own.own === 0 && own.used === 0 && (own.type === AV_CANDIDATE_TYPE || own.type === "video" || own.type === "audio");
  if (own.processing === null && !reservation) {
    return deleteOwnMedia(db, accountId, id, now, own);
  }
  const record = load(db, id);
  const doomable = (att: Attachment | null): att is Attachment =>
    att !== null && attachmentState(att) === "res" && att.scheduled_status_id === null && avReservation(att);
  const before = record.row;
  if (
    doomable(record.att) &&
    (before?.state === "pending" || before?.state === "running") &&
    (before.reply_by === null || now < before.deadline_at)
  ) {
    doom(db, id);
    return "deleted";
  }
  const { att, row } = apply(db, id, record, effectOf(record, now, restoredAt));
  if (row?.state === "staging") {
    return "not_found";
  }
  if (doomable(att)) {
    doom(db, id);
    return "deleted";
  }
  return deleteOwnMedia(db, accountId, id, now);
}

// ---- The owner's GET, PUT and DELETE of an upload (P9, MEDIA-1)

// What the owner's operations decide on of the upload `id` of `accountId`'s, read in one statement before anything else
// of it (undefined for another account's or none): its type, its processing row's state (null without one), whether it
// is live and unattached (`own`, media.ts ownUpload's rule) and, for DELETE, deleteMedia's `used` and `kept`. GET and
// PUT read it with the columns the presenter takes (ownerRow); DELETE without them (ownerFacts). Both select by
// OWNER_SQL's lookup (?1 the id, ?2 the account, ?3 the Store's time).
type OwnerLookup = { processing: ProcessingRow["state"] | null; own: number };
type OwnerFacts = OwnerLookup & { type: string; used: number; kept: number };
type OwnerRow = MediaRow & OwnerLookup;

const OWNER_SQL = {
  state: `(SELECT p.state FROM media_processing p WHERE p.media_id = m.id) AS processing,
				m.status_id IS NULL AND ${liveMediaSql("m", "?3")} AS own`,
  from: `FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX} WHERE m.id = ?1 AND m.account_id = ?2`,
};

function ownerRow(db: Db, accountId: string, id: string, now: number): OwnerRow | undefined {
  return db.first<OwnerRow>(
    `SELECT ${selectSql(MEDIA_COLUMN_MAP)}, ${OWNER_SQL.state} ${OWNER_SQL.from}`,
    id,
    accountId,
    iso(now),
  );
}

function ownerFacts(db: Db, accountId: string, id: string, now: number): OwnerFacts | undefined {
  return db.first<OwnerFacts>(
    `SELECT m.type AS type, ${OWNER_SQL.state},
				m.status_id IS NOT NULL OR m.scheduled_status_id IS NOT NULL AS used, m.gc_at IS NULL AS kept
			${OWNER_SQL.from}`,
    id,
    accountId,
    iso(now),
  );
}

// GET and PUT /api/v1/media/:id (Mastodon's MediaController): `ok` a completed upload (200), `processing` one still
// processing before its deadline_at (206, masked: status-presenter.ts processingMedia), `failed` one failed or past its
// deadline_at, read at the Store's time with no round needed (422), `not_found` anything else (404): another account's,
// attached, a staging reservation (its request still holds it), a doomed or abandoned upload, a reservation never
// staged, as today.
export type OwnerMedia =
  | { status: "ok"; media: MediaAttachment }
  | { status: "processing"; media: MediaAttachment }
  | { status: "failed" }
  | { status: "not_found" };

// The owner's view of the upload `own` names, as K3 and K4 would leave its record at `now` (written nowhere):
// `finished` when it has no processing row, so media.ts's rules for a finished upload decide (ownUpload). The marker is
// asked for only where K3 changes the state: a staging reservation is not found and a v2 upload at its deadline_at
// failed whatever K3 says (K3 deletes the one and fails the other `restored`).
type OwnerState = "finished" | "processing" | "failed" | "not_found";

function ownerState(db: Db, own: OwnerRow | undefined, now: number, restoredAt: Marker): OwnerState {
  if (own === undefined || own.processing === "staging") {
    return "not_found";
  }
  if (own.processing === null) {
    return own.own === 1 ? "finished" : "not_found";
  }
  const record = load(db, own.id);
  const before = record.row;
  if (
    attachmentState(record.att) === "res" &&
    (before?.state === "pending" || before?.state === "running") &&
    before.reply_by === null &&
    now >= before.deadline_at
  ) {
    return "failed";
  }
  // ownerRow has answered a staging row already, and K3 and K4 leave the attachment of a row they keep as it is.
  const state = normalizedState(record, now, restoredAt);
  if (state === null || attachmentState(record.att) !== "res") {
    return "not_found";
  }
  return state === "failed" ? "failed" : "processing";
}

// The owner's answer for `own`, read in `state` (processing or finished).
function shownOwn(db: Db, own: OwnerRow | undefined, state: "processing" | "finished"): OwnerMedia {
  if (own === undefined || (state === "finished" && own.own !== 1)) {
    return { status: "not_found" };
  }
  const media = presentRow(db, own);
  return state === "processing" ? { status: "processing", media: processingMedia(media) } : { status: "ok", media };
}

// GET /api/v1/media/:id.
export const ownerMedia = userReadOperation.atStoreTime("now")<
  { id: string; now: number; restoredAt: Marker },
  OwnerMedia
>((db, { id, now, restoredAt }, { accountId }) => {
  const own = ownerRow(db, accountId, id, now);
  const state = ownerState(db, own, now, restoredAt);
  return state === "processing" || state === "finished" ? shownOwn(db, own, state) : { status: state };
});

// PUT /api/v1/media/:id: the description and focus of an upload still processing are written on its attachment (S6
// leaves them) and it answers 206 as GET does; a failed one is refused (422) and nothing is written; a finished one is
// updated as before.
export const updateOwnerMedia = userWriteOperation.atStoreTime("now")<
  { id: string; changes: MediaChanges; now: number; restoredAt: Marker },
  OwnerMedia
>((db, { id, changes, now, restoredAt }, { accountId }) => {
  const state = ownerState(db, ownerRow(db, accountId, id, now), now, restoredAt);
  if (state !== "processing" && state !== "finished") {
    return { status: state };
  }
  describeMedia(db, id, changes);
  return shownOwn(db, ownerRow(db, accountId, id, now), state);
});

// DELETE /api/v1/media/:id: S11 (deleteAvUpload's rule), the marker read only where K3 changes the answer.
export const deleteOwnerMedia = userMediaDeleteOperation.atStoreTime("now")<
  { id: string; now: number; restoredAt: Marker },
  MediaDeleted
>((db, { id, now, restoredAt }, { accountId }) => deleteUpload(db, accountId, id, now, restoredAt));

// ---- S12 and S13 the dispatch round

type DispatchRun = { id: string; token: string; teardownId: string };

export type DispatchRound = {
  // The pending uploads to dispatch again (`run` under the same name, with the slot's teardown_id).
  runs: DispatchRun[];
  counts: { restored: number; deadline: number; abandoned: number; slots: number };
  // A seek reached DISPATCH_BATCH: the next round has more to do.
  more: boolean;
};

// S12 with S13: the cron's round, nothing in maintenance (the kernel refuses it). Each transition seeks its partial
// index, at most DISPATCH_BATCH each, the restore pass (K3) and the deadline (K4) before the redispatch: rows reserved
// at or before the last restore are failed `restored` (or, staging, deleted with their staging slot); rows past
// deadline_at fail `deadline` (v1: doomed); staging rows past staged_until are deleted with their slots (abandoned);
// slots that no longer count are deleted; and a pending row whose dispatch is DISPATCH_MS old is dispatched again,
// after K3 and K4 on it, so a row their seeks did not reach is failed rather than dispatched.
export const mediaDispatchRound = writeOperation.atStoreTime("now")<Fence, DispatchRound>((db, { now, restoredAt }) => {
  const counts = { restored: 0, deadline: 0, abandoned: 0, slots: 0 };
  let more = false;
  const seek = <T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]): T[] => {
    const rows = db.all<T>(query, ...params, DISPATCH_BATCH);
    more ||= rows.length >= DISPATCH_BATCH;
    return rows;
  };
  // K3 and K4 on one upload, counted by what they did.
  const guarded = (id: string): UploadRecord => {
    const record = load(db, id);
    const effect = effectOf(record, now, restoredAt);
    if (effect === "k3-staging" || effect === "k3-restored") {
      counts.restored++;
    } else if (effect !== null) {
      counts.deadline++;
    }
    return apply(db, id, record, effect);
  };
  // The round's K3 seek needs the restore's time: an unknown marker refuses the round (restoreTime).
  const restored = restoreTime(restoredAt);
  if (restored !== null) {
    for (const { id } of seek<{ id: string }>(
      `SELECT media_id AS id FROM media_processing INDEXED BY media_processing_restore
			WHERE state <> 'failed' AND staged_at <= ? ORDER BY staged_at LIMIT ?`,
      restored,
    )) {
      guarded(id);
    }
  }
  for (const { id } of seek<{ id: string }>(
    `SELECT media_id AS id FROM media_processing INDEXED BY media_processing_deadline
		WHERE state IN ('pending', 'running') AND deadline_at <= ? ORDER BY deadline_at LIMIT ?`,
    now,
  )) {
    guarded(id);
  }
  for (const { id } of seek<{ id: string }>(
    `SELECT media_id AS id FROM media_processing INDEXED BY media_processing_staging
		WHERE state = 'staging' AND staged_until <= ? ORDER BY staged_until LIMIT ?`,
    now,
  )) {
    // K3 first, so a restored staging row counts as K3's.
    const { row } = guarded(id);
    if (row?.state === "staging") {
      deleteRow(db, id);
      deleteSlot(db, id);
      counts.abandoned++;
    }
  }
  const expired = [
    ...seek<{ id: string }>(
      `SELECT media_id AS id FROM media_av_slots INDEXED BY media_av_slots_held
			WHERE granted_at IS NULL AND held_until <= ? ORDER BY held_until LIMIT ?`,
      now,
    ),
    ...seek<{ id: string }>(
      `SELECT media_id AS id FROM media_av_slots INDEXED BY media_av_slots_granted
			WHERE granted_at IS NOT NULL AND granted_at <= ? ORDER BY granted_at LIMIT ?`,
      now - HARD_HOLD_MS,
    ),
  ];
  for (const { id } of expired) {
    deleteSlot(db, id);
    counts.slots++;
  }
  const runs: DispatchRun[] = [];
  for (const due of seek<{ id: string }>(
    `SELECT media_id AS id FROM media_processing INDEXED BY media_processing_dispatch
		WHERE state = 'pending' AND dispatched_at <= ? ORDER BY dispatched_at LIMIT ?`,
    now - DISPATCH_MS,
  )) {
    const { att, row, slot } = guarded(due.id);
    if (row?.state !== "pending" || att?.file_token == null || slot?.teardown_id == null) {
      continue;
    }
    db.run("UPDATE media_processing SET dispatched_at = ? WHERE media_id = ?", now, due.id);
    runs.push({ id: due.id, token: att.file_token, teardownId: slot.teardown_id });
  }
  return { runs, counts, more };
});

// ---- The incoming/ orphan pass

// Three steps, as maintainRemoteMedia's orphan sweep (domain/remote-media.ts) with its checkpoint fenced by a claim:
// incomingSweepClaim hands out the cursor and records the attempt time together, at most once INCOMING_SWEEP_MS, that
// time being the claim; incomingClassify answers, under the claim, the keys of one list page older than
// INCOMING_ORPHAN_AGE_MS that no attachment row holds (a probe copy is never held); incomingSwept moves the cursor only
// for the exact claim, once, and a claim after the last restore, an empty page included. The Worker deletes the
// orphans between the last two, which is idempotent; a restore between them can bring back a row that holds a key the
// page classified (W4): that row is fenced (K3) and never starts, writes or completes.
const INCOMING_SWEEP = "media_incoming_sweep";
const INCOMING_CURSOR_BYTES = 1024;

type SweepState = { at: number; cursor: string; claim: number | null };

function sweepState(db: Db): SweepState {
  let value: unknown = null;
  try {
    value = readState<unknown>(db, INCOMING_SWEEP);
  } catch {
    value = null;
  }
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    at: Number.isSafeInteger(v.at) ? (v.at as number) : 0,
    cursor: typeof v.cursor === "string" && v.cursor.length <= INCOMING_CURSOR_BYTES ? v.cursor : "",
    claim: Number.isSafeInteger(v.claim) ? (v.claim as number) : null,
  };
}

// Whether the claim is the sweep's and was made after the last restore: a claim consumed or not the sweep's is stale
// whatever K3 says, so only the sweep's own claim asks for the marker (restoreTime).
function claimLive(sweep: SweepState, claim: number, restoredAt: Marker): boolean {
  if (sweep.claim === null || sweep.claim !== claim) {
    return false;
  }
  const at = restoreTime(restoredAt);
  return at === null || claim > at;
}

export const incomingSweepClaim = mediaDeleteOperation.atStoreTime("now")<
  { now: number },
  { status: "claimed"; claim: number; cursor: string } | { status: "not_due" }
>((db, { now }) => {
  const sweep = sweepState(db);
  // As the sweep: a Store without its domain (fresh, reset or being bootstrapped) has nothing to delete.
  if (!setUp(db) || (sweep.at > 0 && now - sweep.at < INCOMING_SWEEP_MS)) {
    return { status: "not_due" };
  }
  writeState(db, INCOMING_SWEEP, { at: now, cursor: sweep.cursor, claim: now });
  return { status: "claimed", claim: now, cursor: sweep.cursor };
});

const INCOMING_ID = /^incoming\/(\d{18})$/;
const INCOMING_PROBE = /^incoming\/probe-[0-9a-f]{32}$/;

export const incomingClassify = mediaDeleteOperation.atStoreTime("now")<
  { claim: number; keys: readonly { key: string; uploaded: number }[] } & Fence,
  { status: "ok"; orphans: string[] } | { status: "stale" }
>((db, { claim, keys, now, restoredAt }) => {
  if (!setUp(db) || !claimLive(sweepState(db), claim, restoredAt)) {
    return { status: "stale" };
  }
  const orphans: string[] = [];
  const page: readonly unknown[] = Array.isArray(keys) ? keys : [];
  for (const item of page.slice(0, INCOMING_PAGE_KEYS)) {
    const entry = (typeof item === "object" && item !== null ? item : {}) as { key?: unknown; uploaded?: unknown };
    const key = typeof entry.key === "string" ? entry.key : "";
    const uploaded = Number.isSafeInteger(entry.uploaded) ? (entry.uploaded as number) : null;
    if (uploaded === null || uploaded >= now - INCOMING_ORPHAN_AGE_MS) {
      continue;
    }
    const id = INCOMING_ID.exec(key)?.[1];
    if (id !== undefined) {
      if (
        db.first(`SELECT 1 AS held FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX} WHERE id = ?`, id) === undefined
      ) {
        orphans.push(key);
      }
    } else if (INCOMING_PROBE.test(key)) {
      orphans.push(key);
    }
  }
  return { status: "ok", orphans };
});

export const incomingSwept = mediaDeleteOperation<
  { claim: number; cursor: string | null; restoredAt: Marker },
  { status: "swept" } | { status: "stale" }
>((db, { claim, cursor, restoredAt }) => {
  const sweep = sweepState(db);
  if (!setUp(db) || !claimLive(sweep, claim, restoredAt)) {
    return { status: "stale" };
  }
  const next = typeof cursor === "string" && cursor.length <= INCOMING_CURSOR_BYTES ? cursor : "";
  writeState(db, INCOMING_SWEEP, { at: sweep.at, cursor: next, claim: null });
  return { status: "swept" };
});
