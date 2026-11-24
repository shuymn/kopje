import { selectSql } from "../db/columns";
import { MEDIA_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { iso } from "../platform/iso-time";
import { isoTimeSql, storedApplicationId } from "../platform/stored-bounds";
import { type Page, type PageQuery, presentFor } from "./accounts";
import { admit, admittedPage, ARRAY_ANSWER_BYTES } from "./answer-budget";
import {
  type ApiVisibility,
  API_VISIBILITIES,
  availableSql,
  QUOTE_POLICY_NAMES,
  type QuotePolicyName,
  scheduledOwnSql,
} from "./audience";
import { userReadOperation, userWriteOperation } from "./auth";
import { allocateLocalId } from "./ids";
import { DETACHED_GRACE_MS } from "./media";
import { writeOperation } from "./operation";
import { checkPoll, isPollInput, type PollInput } from "./polls";
import { MAX_STATUS_MEDIA } from "./status-bounds";
import { type MediaAttachment, type MediaRow, presentMedia, type Status } from "./status-presenter";
import { MEDIA_COLUMN_MAP } from "./status-rows";
import {
  convertedPost,
  type CreateStatusInput,
  type CreateStatusResult,
  isPrepared,
  keyCutoff,
  keyFreshSql,
  ownStatusByKey,
  type PostInput,
  postNow,
  postTargetsOf,
  preparePost,
  refusedPost,
  TOO_LONG,
  writePost,
} from "./statuses";
import { ABOVE_EVERY_ID, BELOW_EVERY_ID, statusCursor } from "./windows";

// Scheduled statuses (Mastodon 4.5's ScheduledStatus, PostStatusService#schedule_status!,
// Api::V1::ScheduledStatusesController and PublishScheduledStatusWorker). A post sent with a future scheduled_at is
// checked as a post is, then kept with its parameters until it is due; the cron publishes it through the path of an
// ordinary post (statuses.ts, preparePost and writePost), in the transaction that deletes it, so it is published once.
// Until then it is its owner's alone (R26, scheduledOwnSql): only this module reads scheduled_statuses, every read is
// the owner's, and nothing of it is listed, notified or delivered. The uploads it will attach are held
// (media_attachments.scheduled_status_id): the sweep of unattached uploads leaves them and no other post attaches them.

// ScheduledStatus::TOTAL_LIMIT, DAILY_LIMIT and MINIMUM_OFFSET.
export const TOTAL_LIMIT = 300;
export const DAILY_LIMIT = 25;
const MINIMUM_OFFSET_MS = 5 * 60 * 1000;

// The bound of a stored params document (RES-1), as the schema checks it. What it holds is bounded before (the status
// text's raw bound, at most four media ids, a parent id, a language tag) far under it, but for allowed_mentions, which
// may be as long as the request: a document past the bound is refused as "Record invalid".
export const MAX_PARAMS_BYTES = 128 * 1024;

// At most this many scheduled statuses are published per cron run (RES-6), each in its own transaction.
export const PUBLISH_ROUND = 25;

// REST::ScheduledStatusSerializer's params: the post's options as PostStatusService#scheduled_options keeps them.
// application_id is the client_id of the app it was scheduled through (an app's id, docs/mastodon-deviations.md
// "Instance and apps"), null when storedApplicationId keeps none; the post is published through it, as stored, whether
// or not the app still exists (a removed app's status presents `application: null`). quoted_status_id is the status
// quoted (a boost's original), which R36 judges again when the post is published. The quote policy is the one the
// request chose, or the author's default when it chose none, resolved when the post is scheduled (as Mastodon's
// controller resolves it), by name as the serializer shows it. Ids are strings, and so is a poll's expires_in, as a
// form sends it.
export type ScheduledParams = {
  text: string;
  poll: ScheduledPoll | null;
  media_ids: string[] | null;
  sensitive: boolean | null;
  spoiler_text: string;
  visibility: ApiVisibility | null;
  language: string | null;
  scheduled_at: null;
  in_reply_to_id: string | null;
  application_id: string | null;
  idempotency: null;
  with_rate_limit: false;
  allowed_mentions: string[] | null;
  quoted_status_id: string | null;
  quote_approval_policy: QuotePolicyName;
};

type ScheduledPoll = { options: string[]; expires_in: string; multiple: boolean; hide_totals: boolean };

// REST::ScheduledStatusSerializer. scheduled_at is null for a stored value that is not a time (COLUMNS).
export type ScheduledStatus = {
  id: string;
  scheduled_at: string | null;
  params: ScheduledParams;
  media_attachments: MediaAttachment[];
};

// params as read: NULL for a stored value that is unreadable (paramsReadSql).
type ScheduledRow = { id: string; scheduled_at: string | null; params: string | null };

// Whether the stored params `params` (SQL) are past their stored bound, beside the CHECK of 0011_scheduled_statuses (a
// JSON object within MAX_PARAMS_BYTES): not text, or a NUL anywhere. The CHECK passes both (a BLOB, and json_valid
// stops at the NUL), and JSON.parse throws on each as the Worker reads it (an ArrayBuffer, a raw NUL). The WHEN of
// 0110_scheduled_params's triggers (domain/stored-triggers.ts), and the writer's rule (postStatus).
export function paramsPastBoundSql(params: string): string {
  return `typeof(${params}) <> 'text' OR instr(CAST(${params} AS BLOB), x'00') > 0`;
}

// The stored params `params` (SQL) as read: NULL past paramsPastBoundSql, which a row restored before 0110 may hold.
// Only a prefilter of what JSON.parse refuses: storedParams decides.
export function paramsReadSql(params: string): string {
  return `CASE WHEN NOT (${paramsPastBoundSql(params)}) THEN ${params} END`;
}

// scheduled_at as read: the stored time when it is one Kopje writes, else NULL (isoTimeSql). The CHECK of
// 0011_scheduled_statuses passes an imported value strftime cannot read (the CHECK is then NULL), and its length()
// stops at a NUL, so such a value may hold any bytes; judged by its bytes in SQL, it never reaches JavaScript. A
// scheduled status shows no time for it (null), and an update that sends no new time refuses it (isTime). params as
// paramsReadSql reads them.
const COLUMNS = `ss.id, ${isoTimeSql("ss.scheduled_at")} AS scheduled_at, ${paramsReadSql("ss.params")} AS params`;

// The stored params `text` as JSON.parse reads them, or null when they cannot be read: NULL (paramsReadSql), a parse
// that throws, or a value that is not an object. A scheduled status whose params are unreadable is left out of the
// list, not found when shown or updated, and dropped as `params` when due; it is still deleted.
export function storedParams(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The held media shown, by (position, id): a scheduled status holds at most MAX_STATUS_MEDIA (heldFullSql), the four
// PostStatusService#validate_media! takes, and the LIMIT keeps the read at them.
// undefined: params that cannot be read (storedParams). `params`: the row's, when already read.
function presentScheduled(
  db: Db,
  row: ScheduledRow,
  params: Record<string, unknown> | null = storedParams(row.params),
): ScheduledStatus | undefined {
  if (params === null) {
    return undefined;
  }
  const media = db.all<MediaRow>(
    `SELECT ${selectSql(MEDIA_COLUMN_MAP)} FROM media_attachments m WHERE m.scheduled_status_id = ?
			ORDER BY m.position, m.id LIMIT ${MAX_STATUS_MEDIA}`,
    row.id,
  );
  return {
    id: row.id,
    scheduled_at: row.scheduled_at,
    params: params as ScheduledParams,
    media_attachments: media.map((row) => presentMedia(row)),
  };
}

// The viewer's scheduled status `id`, if it is theirs.
function ownScheduled(db: Db, viewerId: string, id: string): ScheduledRow | undefined {
  return db.first<ScheduledRow>(
    `SELECT ${COLUMNS} FROM scheduled_statuses ss WHERE ss.id = ?1 AND ${scheduledOwnSql("ss", "?2")}`,
    id,
    viewerId,
  );
}

// The params of a stored row, or null when not of the shape this module writes (a restored row has only schema
// validation). A row without a quote policy has nobody, the policy such rows were scheduled with; one without a quoted
// status quotes nothing; one without allowed_mentions checks no mention.
function readParams(text: string | null): ScheduledParams | null {
  const p = storedParams(text);
  if (p === null) {
    return null;
  }
  const optional = (value: unknown, type: string) => value === null || typeof value === type;
  const valid =
    typeof p.text === "string" &&
    typeof p.spoiler_text === "string" &&
    optional(p.sensitive, "boolean") &&
    optional(p.language, "string") &&
    optional(p.in_reply_to_id, "string") &&
    (p.visibility === null || API_VISIBILITIES.includes(p.visibility as ApiVisibility)) &&
    (p.media_ids === null || (Array.isArray(p.media_ids) && p.media_ids.every((id) => typeof id === "string"))) &&
    (p.poll === null || p.poll === undefined || isScheduledPoll(p.poll)) &&
    (p.quote_approval_policy === undefined ||
      QUOTE_POLICY_NAMES.includes(p.quote_approval_policy as QuotePolicyName)) &&
    (p.quoted_status_id === undefined || optional(p.quoted_status_id, "string")) &&
    (p.allowed_mentions === undefined ||
      p.allowed_mentions === null ||
      (Array.isArray(p.allowed_mentions) && p.allowed_mentions.every((id) => typeof id === "string")));
  return valid
    ? ({
        ...p,
        poll: p.poll ?? null,
        quote_approval_policy: p.quote_approval_policy ?? "nobody",
        quoted_status_id: p.quoted_status_id ?? null,
        allowed_mentions: p.allowed_mentions ?? null,
      } as ScheduledParams)
    : null;
}

function isScheduledPoll(value: unknown): value is ScheduledPoll {
  const poll = value as Record<string, unknown>;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(poll.options) &&
    poll.options.every((option) => typeof option === "string") &&
    typeof poll.expires_in === "string" &&
    typeof poll.multiple === "boolean" &&
    typeof poll.hide_totals === "boolean"
  );
}

function pollParams(poll: PollInput | undefined): ScheduledPoll | null {
  return poll === undefined
    ? null
    : {
        options: poll.options,
        expires_in: String(poll.expiresIn),
        multiple: poll.multiple,
        hide_totals: poll.hideTotals,
      };
}

function paramsOf(
  input: PostInput,
  media: readonly string[],
  inReplyToId: string | null,
  quotedStatusId: string | null,
  quotePolicy: QuotePolicyName,
  applicationId: string | null,
): ScheduledParams {
  return {
    text: input.text,
    poll: pollParams(input.poll),
    media_ids: media.length === 0 ? null : [...media],
    sensitive: input.sensitive ?? null,
    spoiler_text: input.spoilerText,
    visibility: input.visibility ?? null,
    language: input.language ?? null,
    scheduled_at: null,
    in_reply_to_id: inReplyToId,
    application_id: applicationId,
    idempotency: null,
    with_rate_limit: false,
    allowed_mentions: input.allowedMentions ?? null,
    quoted_status_id: quotedStatusId,
    quote_approval_policy: quotePolicy,
  };
}

// The post a scheduled status publishes, at the time it is published: the author's defaults (visibility, sensitive,
// language) apply then, as PostStatusService applies them when the worker runs, and a poll is checked again and ends
// its duration after the publication. The quote policy was resolved when it was scheduled; a status published private
// or direct gets nobody (storedQuotePolicy). null: a poll that no longer passes.
function postOf(params: ScheduledParams, now: number): PostInput | null {
  const poll =
    params.poll === null
      ? undefined
      : checkPoll({
          options: params.poll.options,
          expiresIn: params.poll.expires_in,
          multiple: params.poll.multiple,
          hideTotals: params.poll.hide_totals,
        });
  if (poll !== undefined && !isPollInput(poll)) {
    return null;
  }
  return {
    ...(poll === undefined ? {} : { poll }),
    text: params.text,
    visibility: params.visibility ?? undefined,
    spoilerText: params.spoiler_text,
    sensitive: params.sensitive ?? undefined,
    inReplyToId: params.in_reply_to_id ?? undefined,
    language: params.language ?? undefined,
    mediaIds: params.media_ids ?? [],
    quotePolicy: params.quote_approval_policy,
    ...(params.quoted_status_id === null ? {} : { quotedStatusId: params.quoted_status_id }),
    ...(params.allowed_mentions === null ? {} : { allowedMentions: params.allowed_mentions }),
    now,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ScheduledStatus's validations, in Mastodon's order and with its messages: at least MINIMUM_OFFSET ahead, at most
// TOTAL_LIMIT in all and DAILY_LIMIT on the UTC day of `at` (scheduled_at::date). `except` is the scheduled status being
// moved, which does not count against itself. The counts read at most the limit's rows.
function scheduleErrors(db: Db, accountId: string, at: string, now: number, except: string | null): string[] {
  const errors: string[] = [];
  if (Date.parse(at) <= now + MINIMUM_OFFSET_MS) {
    errors.push("Scheduled at date must be in the future");
  }
  const total =
    db.first<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM scheduled_statuses ss
				WHERE ${scheduledOwnSql("ss", "?1")} AND ss.id IS NOT ?2 LIMIT ?3)`,
      accountId,
      except,
      TOTAL_LIMIT,
    )?.n ?? 0;
  if (total >= TOTAL_LIMIT) {
    errors.push(`You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts`);
  }
  const day = Date.parse(`${at.slice(0, 10)}T00:00:00.000Z`);
  const daily =
    db.first<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM scheduled_statuses ss INDEXED BY scheduled_statuses_account_time
				WHERE ${scheduledOwnSql("ss", "?1")} AND ss.scheduled_at >= ?2 AND ss.scheduled_at < ?3 AND ss.id IS NOT ?4
				LIMIT ?5)`,
      accountId,
      iso(day),
      iso(day + DAY_MS),
      except,
      DAILY_LIMIT,
    )?.n ?? 0;
  if (daily >= DAILY_LIMIT) {
    errors.push(`You have exceeded the limit of ${DAILY_LIMIT} scheduled posts for today`);
  }
  return errors;
}

function invalid(errors: string[]): { status: "invalid"; error: string } {
  return { status: "invalid", error: `Validation failed: ${errors.join(", ")}` };
}

// Frees an expired key for a new post, as both tables keep it unique per account (statuses_client_key and the
// scheduled statuses' UNIQUE): the older rows keep no key, and an older scheduled status is published without one.
function releaseKey(db: Db, accountId: string, key: string): void {
  db.run("UPDATE statuses SET client_key = NULL WHERE account_id = ?1 AND client_key = ?2", accountId, key);
  db.run("UPDATE scheduled_statuses SET client_key = NULL WHERE account_id = ?1 AND client_key = ?2", accountId, key);
}

// Whether the scheduled status `scheduled` (SQL, NULL for none) holds MAX_STATUS_MEDIA uploads other than `media`: one
// more would pass what a scheduled status may hold, imports included (RES-6). Reads at most MAX_STATUS_MEDIA + 1 rows
// through media_attachments_scheduled. The WHEN of 0109_scheduled_media_cap's triggers (domain/stored-triggers.ts).
export function heldFullSql(scheduled: string, media: string): string {
  return `${scheduled} IS NOT NULL
  AND (SELECT count(*) FROM (SELECT 1 FROM media_attachments WHERE scheduled_status_id = ${scheduled} AND id <> ${media}
    LIMIT ${MAX_STATUS_MEDIA})) >= ${MAX_STATUS_MEDIA}`;
}

// Detaches the uploads a scheduled status holds, at most MAX_STATUS_MEDIA (heldFullSql), attachable again for a day (as
// a deleted status's) from the Store's time `storeNow` (media.ts liveMediaSql), and deletes it.
function removeScheduled(db: Db, id: string, storeNow: number): void {
  db.run(
    `UPDATE media_attachments SET scheduled_status_id = NULL, position = 0, gc_at = ?2
		WHERE scheduled_status_id = ?1 AND status_id IS NULL`,
    id,
    iso(storeNow + DETACHED_GRACE_MS),
  );
  db.run("DELETE FROM scheduled_statuses WHERE id = ?", id);
}

// The Store-side time of a scheduled_at the Worker parsed: an ISO 8601 UTC time with milliseconds.
function isTime(at: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) && !Number.isNaN(Date.parse(at));
}

export type ScheduleInput = CreateStatusInput & { scheduledAt?: string | undefined };

export type ScheduleResult = CreateStatusResult | { status: "scheduled"; value: ScheduledStatus };

// POST /api/v1/statuses (PostStatusService), with or without scheduled_at. The status replied to and the status quoted
// are checked first (postTargetsOf). Then an Idempotency-Key is resolved, against the account's statuses and its
// scheduled statuses alike, whether this request schedules or not: a repeat within the key's hour (IDEMPOTENCY_MS,
// from the row's created_at) answers with what the first request made, a Status or a ScheduledStatus, and makes
// nothing (so a key that reserved a scheduled status is never posted twice, once now and once when it is published).
// An expired key is taken from the older rows, in this transaction, and posts anew.
// Then the pair as sent is held to the raw bound, and a blank text takes its warning (convertedPost), whether the post
// is made now or scheduled. No scheduled_at, or a time not in the future, posts at once; otherwise the post is checked
// as an immediate one (the status replied to, the media, a blank text), then against ScheduledStatus's validations, and
// kept with its media held.
export const postStatus = userWriteOperation.atStoreTime("storeNow")<
  ScheduleInput & { storeNow: number },
  ScheduleResult
>((db, input, caller, viewer) => {
  const { accountId } = caller;
  // AUTH-6: the app of the credential, which the Worker cannot name.
  const applicationId = storedApplicationId(caller.client.id);
  const targets = postTargetsOf(db, accountId, input);
  if (targets !== "ok") {
    return { status: targets };
  }
  if (input.scheduledAt !== undefined && !isTime(input.scheduledAt)) {
    return { status: "invalid", error: "Record invalid" };
  }
  if (input.idempotencyKey !== undefined) {
    const status: Status | null = ownStatusByKey(db, viewer, input.idempotencyKey, input.present, input.now);
    if (status !== null) {
      return { status: "ok", value: status };
    }
    const scheduled = db.first<ScheduledRow>(
      `SELECT ${COLUMNS} FROM scheduled_statuses ss WHERE ${scheduledOwnSql("ss", "?1")} AND ss.client_key = ?2
				AND ${keyFreshSql("ss.created_at", "?3")}`,
      accountId,
      input.idempotencyKey,
      keyCutoff(input.now),
    );
    // One whose params cannot be read answers as none.
    const shown = scheduled === undefined ? undefined : presentScheduled(db, scheduled);
    if (shown !== undefined) {
      return { status: "scheduled", value: shown };
    }
    releaseKey(db, accountId, input.idempotencyKey);
  }
  const post = convertedPost(input);
  if (post === null) {
    return { status: "invalid", error: TOO_LONG };
  }
  if (post.scheduledAt === undefined || Date.parse(post.scheduledAt) <= post.now) {
    return postNow(db, viewer, post, applicationId, input.storeNow);
  }
  const scheduledAt = post.scheduledAt;
  // As PostStatusService#schedule_status!: allowed_mentions is kept in the params and checked at publication.
  const prepared = preparePost(db, accountId, { ...post, allowedMentions: undefined }, null, input.storeNow);
  if (!isPrepared(prepared)) {
    return refusedPost(db, prepared, presentFor(input.present, accountId));
  }
  const errors = scheduleErrors(db, accountId, scheduledAt, input.now, null);
  if (errors.length > 0) {
    return invalid(errors);
  }
  const params = JSON.stringify(
    paramsOf(
      post,
      prepared.media,
      prepared.parent?.id ?? null,
      prepared.quoted?.id ?? null,
      input.quotePolicy ?? prepared.author.default_quote_policy,
      applicationId,
    ),
  );
  if (new TextEncoder().encode(params).length > MAX_PARAMS_BYTES) {
    return { status: "invalid", error: "Record invalid" };
  }
  // Params past the trigger's bound are refused as the schema's are (JSON.stringify writes none).
  const row = db.first<ScheduledRow>(
    `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, client_key, created_at)
		SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT (${paramsPastBoundSql("?4")}) RETURNING id, scheduled_at, params`,
    allocateLocalId(db, input.now),
    accountId,
    scheduledAt,
    params,
    input.idempotencyKey ?? null,
    iso(input.now),
  );
  if (row === undefined) {
    return { status: "invalid", error: "Record invalid" };
  }
  db.run(
    `UPDATE media_attachments INDEXED BY ${MEDIA_ID_INDEX}
		SET scheduled_status_id = ?1, gc_at = NULL,
			position = (SELECT j.key FROM json_each(?2) j WHERE j.value = media_attachments.id)
		WHERE id IN (SELECT value FROM json_each(?2))`,
    row.id,
    JSON.stringify(prepared.media),
  );
  const value = presentScheduled(db, row);
  if (value === undefined) {
    throw new Error("the scheduled status was written with unreadable params");
  }
  return { status: "scheduled", value };
});

// The default and largest page of GET /api/v1/scheduled_statuses (DEFAULT_STATUSES_LIMIT, and limit_param's cap at
// twice it).
export const SCHEDULED_PAGE = { limit: 20, max: 40 };

// GET /api/v1/scheduled_statuses: the viewer's scheduled statuses by id, newest first, paged by id
// (to_a_paginated_by_id); a page of ids from the account's own index, whoever else has scheduled statuses. Each is read
// and presented by key as admission reaches it, within ANSWER_BYTES (RES-3): a page cut there continues from its last
// admitted scheduled status (admittedPage). One whose params cannot be read is left out, so a page reads toward its
// limit by its ids (Page.cut), as followedTags does: its ends are the ids read, and the Link header passes over the
// rows left out as Mastodon's passes over absent ones.
export const listScheduled = userReadOperation<{ page: PageQuery }, Page<ScheduledStatus>>(
  (db, { page }, { accountId }) => {
    const ascending = page.minId !== undefined;
    const ids = db
      .all<{ id: string }>(
        `SELECT ss.id FROM scheduled_statuses ss
				WHERE ${scheduledOwnSql("ss", "?1")} AND ss.id < coalesce(?2, '${ABOVE_EVERY_ID}')
					AND ss.id > coalesce(?3, '${BELOW_EVERY_ID}')
				ORDER BY ss.id ${ascending ? "ASC" : "DESC"} LIMIT ?4`,
        accountId,
        statusCursor(page.maxId),
        statusCursor(page.minId ?? page.sinceId),
        page.limit,
      )
      .map((row) => row.id);
    if (ascending) {
      ids.reverse();
    }
    function* presented(traversal: readonly string[]): Generator<ScheduledStatus | undefined> {
      for (const id of traversal) {
        const row = ownScheduled(db, accountId, id);
        yield row === undefined ? undefined : presentScheduled(db, row);
      }
    }
    return admittedPage(
      { rows: ids, newest: ids[0] ?? null, oldest: ids.at(-1) ?? null, cut: ids.length >= page.limit },
      ascending,
      (id) => id,
      (traversal) => admit(presented(traversal), ARRAY_ANSWER_BYTES, true),
    );
  },
);

// GET /api/v1/scheduled_statuses/:id: null when it is not the viewer's, or its params cannot be read.
export const getScheduled = userReadOperation<{ id: string }, ScheduledStatus | null>((db, { id }, { accountId }) => {
  const row = ownScheduled(db, accountId, id);
  return (row === undefined ? undefined : presentScheduled(db, row)) ?? null;
});

export type UpdateScheduledResult =
  | { status: "ok"; value: ScheduledStatus }
  | { status: "not_found" }
  | { status: "invalid"; error: string };

// PUT and PATCH /api/v1/scheduled_statuses/:id (update!(scheduled_at)): only the time changes, and the validations
// run again for the new time (or the current one when none is sent). null: a time the Worker could not read. One
// whose params cannot be read is not found, as it is not shown.
export const updateScheduled = userWriteOperation<
  { id: string; scheduledAt: string | null | undefined; now: number },
  UpdateScheduledResult
>((db, input, { accountId }) => {
  const row = ownScheduled(db, accountId, input.id);
  const params = row === undefined ? null : storedParams(row.params);
  if (row === undefined || params === null) {
    return { status: "not_found" };
  }
  const at = input.scheduledAt === undefined ? row.scheduled_at : input.scheduledAt;
  if (at === null || !isTime(at)) {
    return { status: "invalid", error: "Record invalid" };
  }
  const errors = scheduleErrors(db, accountId, at, input.now, row.id);
  if (errors.length > 0) {
    return invalid(errors);
  }
  // A new time is a new schedule: failed attempts at the old one no longer count.
  db.run(
    "UPDATE scheduled_statuses SET scheduled_at = ?, attempts = 0, next_attempt_at = NULL WHERE id = ?",
    at,
    row.id,
  );
  const value = presentScheduled(db, { ...row, scheduled_at: at }, params);
  return value === undefined ? { status: "not_found" } : { status: "ok", value };
});

// DELETE /api/v1/scheduled_statuses/:id: its uploads are detached (attachable again for a day), as Mastodon nullifies
// them, its params read or not. Whether it was the viewer's.
export const deleteScheduled = userWriteOperation.atStoreTime("storeNow")<
  { id: string; now: number; storeNow: number },
  boolean
>((db, input, { accountId }) => {
  const row = ownScheduled(db, accountId, input.id);
  if (row === undefined) {
    return false;
  }
  removeScheduled(db, row.id, input.storeNow);
  return true;
});

// ---- Publication (the cron, jobs/scheduled.ts).

// Publication attempts that fail with an error, not a refusal of the post (which drops it at once): retried after
// RETRY_DELAYS_MS (one per failure before the last), then dropped after MAX_ATTEMPTS, its media detached.
export const MAX_ATTEMPTS = 5;
export const RETRY_DELAYS_MS = [5, 15, 60, 240].map((minutes) => minutes * 60 * 1000);

// The ids of up to `limit` scheduled statuses due at `now`: those never attempted first, by scheduled time, then those
// to retry, by their next attempt, each through its partial index, so a run publishes what is newly due however many
// keep failing. Declared a write, as the start of the round that publishes them: the Store refuses it in maintenance
// and readonly, so a round then publishes nothing and what is due waits.
export const dueScheduled = writeOperation<{ now: number; limit: number }, string[]>((db, { now, limit }) => {
  const cap = Math.min(limit, PUBLISH_ROUND);
  const fresh = db
    .all<{ id: string }>(
      "SELECT id FROM scheduled_statuses WHERE attempts = 0 AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?",
      iso(now),
      cap,
    )
    .map((row) => row.id);
  const retries =
    fresh.length >= cap
      ? []
      : db
          .all<{ id: string }>(
            `SELECT id FROM scheduled_statuses WHERE attempts > 0 AND next_attempt_at <= ?
						ORDER BY next_attempt_at, id LIMIT ?`,
            iso(now),
            cap - fresh.length,
          )
          .map((row) => row.id);
  return [...fresh, ...retries];
});

export type Failure = { status: "gone" } | { status: "retry"; attempts: number } | { status: "dropped" };

// Records a publication of `id` that failed with an error, in its own transaction after the failed one rolled back:
// one more attempt, and the next after its delay, or, at MAX_ATTEMPTS, the scheduled status dropped and its media
// detached (attachable again for a day).
export const recordPublishFailure = writeOperation.atStoreTime("storeNow")<
  { id: string; now: number; storeNow: number },
  Failure
>((db, { id, now, storeNow }) => {
  const row = db.first<{ attempts: number }>("SELECT attempts FROM scheduled_statuses WHERE id = ?", id);
  if (row === undefined) {
    return { status: "gone" };
  }
  const attempts = row.attempts + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (attempts >= MAX_ATTEMPTS || delay === undefined) {
    removeScheduled(db, id, storeNow);
    return { status: "dropped" };
  }
  db.run(
    "UPDATE scheduled_statuses SET attempts = ?, next_attempt_at = ? WHERE id = ?",
    attempts,
    iso(now + delay),
    id,
  );
  return { status: "retry", attempts };
});

export type Publication =
  | { status: "gone" }
  | { status: "published"; statusId: string }
  | {
      status: "dropped";
      reason: "unavailable" | "params" | "reply_not_found" | "quote_not_found" | "invalid" | "unexpected_mentions";
    };

// Publishes the scheduled status `id` if it is still due: deletes it and, in the same transaction, posts it through
// the path of an immediate post (preparePost, writePost), with its held media, so it is published once however many
// runs or retries reach it. As PublishScheduledStatusWorker, a post that no longer passes (the status replied to is
// gone or hidden, the status quoted is gone or R36 no longer lets the author quote it, its text is blank without media,
// its media is gone, it would mention an account its allowed_mentions does not list, its account is suspended) is
// dropped: deleted without a status,
// its media detached. The status is created at the time of publication (PostStatusService does not take the scheduled
// time), and its Idempotency-Key carries over while it has not expired, so a client repeating the request within the
// key's hour is answered with it, until an hour after the publication.
export const publishScheduled = writeOperation.atStoreTime("storeNow")<
  { id: string; now: number; storeNow: number; objectId: string },
  Publication
>((db, { id, now, storeNow, objectId }) => {
  const row = db.first<PublishRow>(
    `SELECT ss.account_id, ${paramsReadSql("ss.params")} AS params,
				CASE WHEN ${keyFreshSql("ss.created_at", "?3")} THEN ss.client_key END AS client_key,
				${availableSql("ss.account_id")} AS available
			FROM scheduled_statuses ss WHERE ss.id = ?1
				AND (ss.attempts = 0 AND ss.scheduled_at <= ?2 OR ss.attempts > 0 AND ss.next_attempt_at <= ?2)`,
    id,
    iso(now),
    keyCutoff(now),
  );
  if (row === undefined) {
    return { status: "gone" };
  }
  const publication = publish(db, id, row, now, storeNow, objectId);
  removeScheduled(db, id, storeNow);
  return publication;
});

// client_key: the key while it has not expired, else null. params as paramsReadSql reads them.
type PublishRow = { account_id: string; params: string | null; client_key: string | null; available: number };

function publish(db: Db, id: string, row: PublishRow, now: number, storeNow: number, objectId: string): Publication {
  if (row.available !== 1) {
    return { status: "dropped", reason: "unavailable" };
  }
  const params = readParams(row.params);
  if (params === null) {
    return { status: "dropped", reason: "params" };
  }
  const input = postOf(params, now);
  if (input === null) {
    return { status: "dropped", reason: "invalid" };
  }
  const prepared = preparePost(db, row.account_id, input, id, storeNow);
  if (!isPrepared(prepared)) {
    return { status: "dropped", reason: prepared.status };
  }
  // The key is unique per account among statuses; one already taken is left off rather than refuse the post.
  const keyTaken =
    row.client_key !== null &&
    db.first(
      "SELECT 1 AS taken FROM statuses WHERE account_id = ? AND client_key = ?",
      row.account_id,
      row.client_key,
    ) !== undefined;
  const statusId = writePost(
    db,
    row.account_id,
    {
      ...input,
      idempotencyKey: row.client_key === null || keyTaken ? undefined : row.client_key,
      objectId,
      // A restored row's params hold any JSON: an id the bound refuses publishes the post without an app.
      applicationId: storedApplicationId(params.application_id),
    },
    prepared,
  );
  return { status: "published", statusId };
}
