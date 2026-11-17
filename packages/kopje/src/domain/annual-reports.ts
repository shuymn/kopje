import { POLLS_STATUS_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import {
  type AnnualReportArchetype,
  isoTimeSql,
  presentedCountSql,
  settingProjectionSql,
  storedTime,
} from "../platform/stored-bounds";
import { type Account, presentAccountsWithin, presentFor, type PresentInput } from "./accounts";
import { ANSWER_BYTES, jsonBytes } from "./answer-budget";
import { annualReportCountedSql, annualReportOwnSql, DISTRIBUTABLE_SQL, viewableStatusIds } from "./audience";
import { type UserContext, userReadOperation, userWriteOperation } from "./auth";
import { tagNameSql } from "./status-bounds";
import { presentation, presentStatusesWithin, type Status } from "./status-presenter";
import { listedTagName, TAG_NAME_JSON_BYTES } from "./tag-bounds";

// Annual reports (Wrapstodon) as Mastodon 4.7.5 makes them (AnnualReport, Api::V1::AnnualReportsController), its
// four sources (Archetype, TopStatuses, TimeSeries, TopHashtags) computed from the owner's statuses of the year's id
// range and stored as schema 2 (annual_reports, migration 0093). Who sees a report and which statuses count: R44
// (audience.ts annualReportOwnSql, annualReportCountedSql).
//
// The campaign (campaignYear) is December 10 to 31 of the Store clock's UTC year while the operator's `wrapstodon`
// setting is not 'false'. Every operation that judges it, or stamps a time, takes the Store's own time (atStoreTime),
// so one clock decides the gate and records when a report was computed. A report is a record, not a cache: it is never
// recomputed, and once the owner's report for a year exists, `state` answers `available` and `generate` writes nothing
// whatever the campaign, the switch or the year's statuses.
//
// Generation runs within the `generate` request, in one Store write operation, and `state` decides in one read: both
// read the year through the same bounded statements, so their work has a ceiling derived from the caps below (RES-7).
// Each cap counts raw candidates (cap + 1, so passing it is seen without reading further), checked in cost order:
// the year's statuses (YEAR_STATUSES_SQL), the accepted followers (FOLLOWERS_SQL), then the hashtag uses and their
// name bytes (TAG_USES_SQL). An account past a cap gets no report: `state` answers `ineligible`, `generate` writes
// nothing, and the operation logs kopje.annual_reports.capped (docs/mastodon-deviations.md, "Annual reports").
// TAG_USES_SQL counts in the same transaction, over a superset of the rows TOP_HASHTAG_SQL groups, the name bytes the
// grouping takes in: the runtime backstop of that memory (REPORT_HASHTAG_BYTES).

// ---- Bounds

// The caps are the largest of 20,000, 50,000, 100,000 and 200,000 for which `state` and then `generate` on the all-caps
// witness run within 1,000 ms together (test/bench/annual-report.bench.ts; the figures are in RES-7).

// The owner's statuses in the year's id range, raw: boosts, every visibility and withdrawn rows included.
export const REPORT_YEAR_STATUSES = 200_000;
// status_tags rows of those statuses, raw.
export const REPORT_HASHTAG_USES = 200_000;
// The UTF-8 bytes of those rows' names, summed: what TOP_HASHTAG_SQL groups at most.
export const REPORT_HASHTAG_BYTES = 8 * 1024 * 1024;
// Accepted follows naming the owner, raw (any year).
export const REPORT_FOLLOWERS = 200_000;
// The most used names TOP_HASHTAG_SQL orders and returns; the first that listedTagName admits is the report's.
export const REPORT_TAG_CANDIDATES = 32;
// Pending reports GET /api/v1/annual_reports lists, newest year first (Mastodon lists all, unordered).
export const REPORTS_LISTED = 40;

// The JSON of one presented report at its bounds, in UTF-8 bytes: the year's four digits, an archetype of at most
// eight bytes, counts of at most 16 digits (SAFE_INTEGER_MAX), 18-digit ids and a name of at most
// TAG_NAME_JSON_BYTES escaped (test/annual-report-bounds.test.ts measures a report at it).
export const REPORT_JSON_BYTES =
  jsonBytes({
    year: 9999,
    data: {
      archetype: "pollster",
      top_statuses: { by_reblogs: "0".repeat(18), by_favourites: null, by_replies: null },
      time_series: [{ month: 12, statuses: Number.MAX_SAFE_INTEGER, followers: Number.MAX_SAFE_INTEGER }],
      top_hashtags: [{ name: "", count: Number.MAX_SAFE_INTEGER }],
    },
    schema_version: 2,
    share_url: null,
    account_id: "0".repeat(18),
  }) + TAG_NAME_JSON_BYTES;

// ---- The campaign

// S1: whether the operator's `wrapstodon` setting is on: off only when stored 'false' (read through its bound,
// WRAPSTODON_SETTING_BOUNDS); no row is on, Mastodon's default (config/settings.yml). One key read.
export const WRAPSTODON_SQL = `SELECT ${settingProjectionSql("wrapstodon", "value")} AS value FROM instance_settings
	WHERE name = 'wrapstodon'`;

export function wrapstodonOn(db: Db): boolean {
  return db.first<{ value: string | null }>(WRAPSTODON_SQL)?.value !== "false";
}

// AnnualReport.current_campaign: the UTC year of `now` while it is December 10 to 31 of that year and the setting is
// `on`, else null. Mastodon's month-and-day test written as a time range, so that each boundary is one comparison:
// `year` is the year of the latest December 10 at or before `now`, and the campaign runs until the next January 1.
// `now` is the Store's own time: every operation that judges the campaign is declared atStoreTime.
export function campaignYear(now: number, on: boolean): number | null {
  const utcYear = new Date(now).getUTCFullYear();
  const year = now >= Date.UTC(utcYear, 11, 10) ? utcYear : utcYear - 1;
  return on && now < Date.UTC(year + 1, 0, 1) ? year : null;
}

// The year a path's id names (Ruby's to_i, as ids.ts requestedId reads it): 1 to 9999, the years a report row may
// hold; anything else names no report.
function reportYear(requested: string): number | null {
  return /^[1-9][0-9]{0,3}$/.test(requested) ? Number(requested) : null;
}

// The year's bounds: the ids of its statuses from `start` (inclusive) to `end` (exclusive), as 18-digit TEXT (DATA-6;
// (ms << 16) has 18 digits for every year from 2019 to 2453, and only a campaign year, by the Store's clock, is read),
// and the stored times from `from` to `to` likewise. Mastodon's bounds fall at random within the year's first and last
// second (Mastodon::Snowflake.id_at); Kopje's are the UTC year exactly.
function yearRange(year: number): { start: string; end: string; from: string; to: string } {
  const first = Date.UTC(year, 0, 1);
  const next = Date.UTC(year + 1, 0, 1);
  return { start: idAt(first), end: idAt(next), from: isoAt(first), to: isoAt(next) };
}

function idAt(ms: number): string {
  const text = (BigInt(ms) << 16n).toString();
  if (text.length !== 18) {
    throw new RangeError(`annual reports: no 18-digit id at ${ms}`);
  }
  return text;
}

function isoAt(ms: number): string {
  const time = storedTime(ms);
  if (time === null) {
    throw new RangeError(`annual reports: no stored time at ${ms}`);
  }
  return time;
}

// ---- The year's statements (RES-7). ?1 is the owner, ?2 and ?3 the year's range (or its times, FOLLOWERS_IN_YEAR).
// Every one pins its index and join order; every stage that bounds raw candidates is a LIMIT subquery, and every
// residual condition (withdrawn, visibility, counts, the follow's time, the name's bound) is applied outside it.

// The owner's rows of the year in id order, raw, with what the sources read of each (`w` in the statements).
const YEAR_ROWS_SQL = `SELECT s.id, s.withdrawn, s.visibility, s.reblog_of_id, s.in_reply_to_uri, s.in_reply_to_id,
		s.in_reply_to_account_id, s.replies_count, s.reblogs_count, s.favourites_count
	FROM statuses s INDEXED BY statuses_account WHERE s.account_id = ?1 AND s.id >= ?2 AND s.id < ?3
	ORDER BY s.id LIMIT ${REPORT_YEAR_STATUSES + 1}`;

// C1: the year's rows, counted up to REPORT_YEAR_STATUSES + 1 on the covering index.
export const YEAR_STATUSES_SQL = `SELECT count(*) AS n FROM (SELECT 1 FROM statuses INDEXED BY statuses_account
	WHERE account_id = ?1 AND id >= ?2 AND id < ?3 LIMIT ${REPORT_YEAR_STATUSES + 1})`;

// C2: the accepted followers, counted up to REPORT_FOLLOWERS + 1 on the covering index.
export const FOLLOWERS_SQL = `SELECT count(*) AS n FROM (SELECT 1 FROM follows INDEXED BY follows_target
	WHERE target_account_id = ?1 AND state = 'accepted' LIMIT ${REPORT_FOLLOWERS + 1})`;

// C3: the year's hashtag uses up to REPORT_HASHTAG_USES + 1, their name bytes, and whether a counted status has one.
export const TAG_USES_SQL = `SELECT count(*) AS uses, coalesce(sum(bytes), 0) AS bytes,
		coalesce(max(${annualReportCountedSql("u")}), 0) AS tagged
	FROM (SELECT w.withdrawn, octet_length(t.name) AS bytes FROM (${YEAR_ROWS_SQL}) w
		CROSS JOIN status_tags t ON t.status_id = w.id LIMIT ${REPORT_HASHTAG_USES + 1}) u`;

// C4: whether a counted status of the year is public or unlisted (TopStatuses#eligible?, boosts included).
export const DISTRIBUTABLE_YEAR_SQL = `SELECT EXISTS (SELECT 1 FROM (${YEAR_ROWS_SQL}) w
	WHERE ${annualReportCountedSql("w")} AND w.visibility IN ${DISTRIBUTABLE_SQL}) AS distributable`;

// G1: the counted statuses (TimeSeries) and the Archetype's counts. Standalone: not a reply to another account
// (Status.without_replies: in_reply_to_uri, Mastodon's `reply`, read for every reply, resolved or not) and not a
// boost; replies: a resolved reply to another account (not_replying_to_account, so an unknown parent author counts in
// neither); a poll is a polls row, probed for counted rows only.
export const ARCHETYPE_SQL = `SELECT count(*) AS statuses,
		count(CASE WHEN w.reblog_of_id IS NULL AND (w.in_reply_to_uri IS NULL OR w.in_reply_to_account_id = ?1)
			THEN 1 END) AS standalone,
		count(CASE WHEN w.in_reply_to_id IS NOT NULL AND w.in_reply_to_account_id <> ?1 THEN 1 END) AS replies,
		count(CASE WHEN w.reblog_of_id IS NOT NULL THEN 1 END) AS reblogs,
		count(CASE WHEN EXISTS (SELECT 1 FROM polls p INDEXED BY ${POLLS_STATUS_INDEX} WHERE p.status_id = w.id)
			THEN 1 END) AS polls
	FROM (${YEAR_ROWS_SQL}) w WHERE ${annualReportCountedSql("w")}`;

// G2: TopStatuses#most_reblogged_status: the counted public or unlisted original with the most boosts among those
// with a reply, boost or favourite (Kopje's stand-in for a status_stats row), ties to the lowest id. A boost row never
// has counts, so leaving boosts out changes nothing Mastodon would pick.
export const TOP_STATUS_SQL = `SELECT w.id FROM (${YEAR_ROWS_SQL}) w
	WHERE ${annualReportCountedSql("w")} AND w.reblog_of_id IS NULL AND w.visibility IN ${DISTRIBUTABLE_SQL}
		AND (${presentedCountSql("w.replies_count")} > 0 OR ${presentedCountSql("w.reblogs_count")} > 0
			OR ${presentedCountSql("w.favourites_count")} > 0)
	ORDER BY ${presentedCountSql("w.reblogs_count")} DESC, w.id LIMIT 1`;

// G3: TopHashtags: the counted statuses' names within tagNameSql's bound, grouped by name, more than one use
// (MINIMUM_TAGGINGS), most used first, ties by name (BINARY); only the REPORT_TAG_CANDIDATES first, as hex keys. The
// caller stores the first that listedTagName admits (the SQL bound only prefilters).
export const TOP_HASHTAG_SQL = `SELECT hex(name) AS key, uses FROM (SELECT name, count(*) AS uses
		FROM (SELECT w.withdrawn, ${tagNameSql("t.name")} AS name FROM (${YEAR_ROWS_SQL}) w
			CROSS JOIN status_tags t ON t.status_id = w.id LIMIT ${REPORT_HASHTAG_USES + 1}) u
		WHERE ${annualReportCountedSql("u")} AND name IS NOT NULL GROUP BY name HAVING uses > 1)
	ORDER BY uses DESC, name LIMIT ${REPORT_TAG_CANDIDATES}`;

// G4: TimeSeries' followers: accepted follows of the owner whose stored time (the request's, isoTimeSql) lies in the
// year, ?2 to ?3. Mastodon's is the acceptance's (docs/mastodon-deviations.md, "Annual reports").
export const FOLLOWERS_IN_YEAR_SQL = `SELECT count(*) AS n FROM (SELECT f.created_at FROM follows f
		INDEXED BY follows_target WHERE f.target_account_id = ?1 AND f.state = 'accepted' LIMIT ${REPORT_FOLLOWERS + 1})
	WHERE ${isoTimeSql("created_at")} >= ?2 AND ${isoTimeSql("created_at")} < ?3`;

// A1: whether the owner's report for the year ?2 exists.
export const REPORT_EXISTS_SQL = `SELECT 1 AS x FROM annual_reports r WHERE ${annualReportOwnSql("r", "?1")} AND r.year = ?2`;

// G5: the report, its name copied as the stored bytes.
export const INSERT_REPORT_SQL = `INSERT INTO annual_reports (account_id, year, archetype, statuses, followers,
		top_status_id, top_hashtag, top_hashtag_uses, viewed_at, created_at)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6, CAST(unhex(?7) AS TEXT), ?8, NULL, ?9)`;

const ANNUAL_REPORT_COLUMNS = `r.year, r.archetype, r.statuses, r.followers, r.top_status_id, hex(r.top_hashtag) AS top_hashtag,
	r.top_hashtag_uses`;

// One report by its key (show).
const REPORT_SQL = `SELECT ${ANNUAL_REPORT_COLUMNS} FROM annual_reports r WHERE ${annualReportOwnSql("r", "?1")} AND r.year = ?2`;

// A2: the owner's pending reports, newest year first (index).
export const PENDING_REPORTS_SQL = `SELECT ${ANNUAL_REPORT_COLUMNS} FROM annual_reports r INDEXED BY annual_reports_pending
	WHERE ${annualReportOwnSql("r", "?1")} AND r.viewed_at IS NULL ORDER BY r.year DESC LIMIT ${REPORTS_LISTED}`;

// GeneratedAnnualReport#view!: the owner's report of ?2 marked read at ?3.
const VIEW_REPORT_SQL = `UPDATE annual_reports SET viewed_at = ?3
	WHERE ${annualReportOwnSql("annual_reports", "?1")} AND year = ?2`;

// ---- Reading the year

export type ReportCap = "statuses" | "hashtag_uses" | "hashtag_bytes" | "followers";

// The caps in cost order, the first passed stopping the read; else whether a counted status has a hashtag.
function boundedYear(
  db: Db,
  owner: string,
  range: { start: string; end: string },
): { capped: ReportCap } | { capped: null; tagged: boolean } {
  const statuses = db.first<{ n: number }>(YEAR_STATUSES_SQL, owner, range.start, range.end)?.n ?? 0;
  if (statuses > REPORT_YEAR_STATUSES) {
    return { capped: "statuses" };
  }
  const followers = db.first<{ n: number }>(FOLLOWERS_SQL, owner)?.n ?? 0;
  if (followers > REPORT_FOLLOWERS) {
    return { capped: "followers" };
  }
  const tags = db.first<{ uses: number; bytes: number; tagged: number }>(TAG_USES_SQL, owner, range.start, range.end);
  if ((tags?.uses ?? 0) > REPORT_HASHTAG_USES) {
    return { capped: "hashtag_uses" };
  }
  if ((tags?.bytes ?? 0) > REPORT_HASHTAG_BYTES) {
    return { capped: "hashtag_bytes" };
  }
  return { capped: null, tagged: tags?.tagged === 1 };
}

// The reason code of a refusal past a cap (DATA-5: no account, year, name or id; docs/observability.md).
function logCapped(cap: ReportCap, call: "state" | "generate"): void {
  console.warn({ event: "kopje.annual_reports.capped", cap, call });
}

function reportExists(db: Db, owner: string, year: number): boolean {
  return db.first(REPORT_EXISTS_SQL, owner, year) !== undefined;
}

// Archetype::AVERAGE_PER_YEAR.
const AVERAGE_PER_YEAR = 113;

// Archetype#archetype, with Ruby's operands (`polls > standalone * 0.1` is the same IEEE double arithmetic).
export function archetypeOf(c: {
  standalone: number;
  replies: number;
  reblogs: number;
  polls: number;
}): AnnualReportArchetype {
  if (c.standalone + c.replies + c.reblogs < AVERAGE_PER_YEAR) {
    return "lurker";
  }
  if (c.reblogs > c.standalone * 2) {
    return "booster";
  }
  if (c.polls > c.standalone * 0.1) {
    return "pollster";
  }
  if (c.replies > c.standalone * 2) {
    return "replier";
  }
  return "oracle";
}

// The first of the most used names listedTagName admits, as its stored bytes' hex key and its uses; null when none is.
function topHashtag(db: Db, owner: string, range: { start: string; end: string }) {
  for (const row of db.all<{ key: string; uses: number }>(TOP_HASHTAG_SQL, owner, range.start, range.end)) {
    if (listedTagName(row.key) !== null) {
      return row;
    }
  }
  return null;
}

// Writes the owner's report of `year` from the four sources (the caps already checked in this transaction).
function generate(db: Db, owner: string, year: number, storeNow: number): void {
  const range = yearRange(year);
  const counts = db.first<{ statuses: number; standalone: number; replies: number; reblogs: number; polls: number }>(
    ARCHETYPE_SQL,
    owner,
    range.start,
    range.end,
  ) ?? { statuses: 0, standalone: 0, replies: 0, reblogs: 0, polls: 0 };
  const top = db.first<{ id: string }>(TOP_STATUS_SQL, owner, range.start, range.end)?.id ?? null;
  const hashtag = topHashtag(db, owner, range);
  const followers = db.first<{ n: number }>(FOLLOWERS_IN_YEAR_SQL, owner, range.from, range.to)?.n ?? 0;
  db.run(
    INSERT_REPORT_SQL,
    owner,
    year,
    archetypeOf(counts),
    counts.statuses,
    followers,
    top,
    hashtag?.key ?? null,
    hashtag?.uses ?? null,
    isoAt(storeNow),
  );
}

// ---- Operations

export type AnnualReportState = "available" | "eligible" | "ineligible";

// GET /api/v1/annual_reports/:id/state (AnnualReport#state): `available` when the owner's report exists, whatever
// the campaign; else `eligible` for the campaign year when every cap holds and the year has a counted public or
// unlisted status and a counted status with a hashtag (Archetype and TimeSeries are always eligible); else
// `ineligible`. No `generating`: generation finishes within its request. Outside the campaign no status is read.
export const annualReportState = userReadOperation.atStoreTime("storeNow")<
  { year: string; storeNow: number },
  AnnualReportState
>((db, { year: requested, storeNow }, viewer) => {
  const year = reportYear(requested);
  if (year === null) {
    return "ineligible";
  }
  if (reportExists(db, viewer.accountId, year)) {
    return "available";
  }
  if (year !== campaignYear(storeNow, wrapstodonOn(db))) {
    return "ineligible";
  }
  const range = yearRange(year);
  const read = boundedYear(db, viewer.accountId, range);
  if (read.capped !== null) {
    logCapped(read.capped, "state");
    return "ineligible";
  }
  const distributable = db.first<{ distributable: number }>(
    DISTRIBUTABLE_YEAR_SQL,
    viewer.accountId,
    range.start,
    range.end,
  );
  return read.tagged && distributable?.distributable === 1 ? "eligible" : "ineligible";
});

// POST /api/v1/annual_reports/:id/generate (AnnualReportsController#generate and AnnualReport#generate): for the
// campaign year without a report, the report written in this operation when every cap holds; nothing otherwise.
// Eligibility is not checked, as Mastodon's. The answer is 200 {} either way, so it carries nothing.
export const generateAnnualReport = userWriteOperation.atStoreTime("storeNow")<
  { year: string; storeNow: number },
  void
>((db, { year: requested, storeNow }, viewer) => {
  const year = reportYear(requested);
  if (year === null || year !== campaignYear(storeNow, wrapstodonOn(db))) {
    return;
  }
  if (reportExists(db, viewer.accountId, year)) {
    return;
  }
  const read = boundedYear(db, viewer.accountId, yearRange(year));
  if (read.capped !== null) {
    logCapped(read.capped, "generate");
    return;
  }
  generate(db, viewer.accountId, year, storeNow);
});

// ---- Presentation

// REST::AnnualReportSerializer: `data` of schema 2 in Mastodon's key order, `share_url` null (no share page, MD-9),
// `account_id` the owner's id.
type AnnualReport = {
  year: number;
  data: AnnualReportData;
  schema_version: 2;
  share_url: null;
  account_id: string;
};

type AnnualReportData = {
  archetype: AnnualReportArchetype;
  top_statuses: { by_reblogs: string | null; by_favourites: null; by_replies: null };
  time_series: { month: 12; statuses: number; followers: number }[];
  top_hashtags: { name: string; count: number }[];
};

// REST::AnnualReportsSerializer.
export type AnnualReports = { annual_reports: AnnualReport[]; accounts: Account[]; statuses: Status[] };

// A report row as stored (migration 0093's CHECKs bound each column: the counts are safe integers, the archetype one
// of five words) with its name as the hex of its bytes.
type ReportRow = {
  year: number;
  archetype: AnnualReportArchetype;
  statuses: number;
  followers: number;
  top_status_id: string | null;
  top_hashtag: string | null;
  top_hashtag_uses: number | null;
};

// The JSON of an empty answer: each list's items are counted with a separator, one more than they take.
const FRAME_BYTES = jsonBytes({ annual_reports: [], accounts: [], statuses: [] } satisfies AnnualReports);

// The reports, the owner's account when any is listed (AnnualReportsPresenter#accounts), and the top statuses the
// owner may view (R3, VIS-12: one deleted, withdrawn or not the owner's to see leaves by_reblogs null), newest first,
// each admitted whole within what ANSWER_BYTES leaves (RES-3). No continuation: Mastodon has none.
function presentReports(
  db: Db,
  rows: readonly ReportRow[],
  context: UserContext,
  present: PresentInput,
): AnnualReports {
  const owner = context.accountId;
  const viewable = viewableStatusIds(
    db,
    owner,
    rows.flatMap((row) => row.top_status_id ?? []),
  );
  const shown = new Set<string>(viewable);
  const reports = rows.map((row): AnnualReport => {
    const name = listedTagName(row.top_hashtag);
    return {
      year: row.year,
      data: {
        archetype: row.archetype,
        top_statuses: {
          by_reblogs: row.top_status_id !== null && shown.has(row.top_status_id) ? row.top_status_id : null,
          by_favourites: null,
          by_replies: null,
        },
        time_series: [{ month: 12, statuses: row.statuses, followers: row.followers }],
        top_hashtags: name === null || row.top_hashtag_uses === null ? [] : [{ name, count: row.top_hashtag_uses }],
      },
      schema_version: 2,
      share_url: null,
      account_id: owner,
    };
  });
  let left = ANSWER_BYTES - FRAME_BYTES - reports.reduce((bytes, report) => bytes + jsonBytes(report) + 1, 0);
  const accounts =
    reports.length === 0
      ? { items: [], bytes: 0 }
      : presentAccountsWithin(db, [owner], presentFor(present, owner), left, true);
  left -= accounts.bytes;
  const newest = viewable.toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const statuses = presentStatusesWithin(
    db,
    presentation(db, newest, { ...present, viewer: context }),
    newest,
    left,
    accounts.items.length === 0,
  );
  return { annual_reports: reports, accounts: accounts.items, statuses: statuses.items };
}

// GET /api/v1/annual_reports: the owner's pending reports (GeneratedAnnualReport.pending), at most REPORTS_LISTED.
export const annualReports = userReadOperation<{ present: PresentInput }, AnnualReports>(
  (db, { present }, _v, context) =>
    presentReports(db, db.all<ReportRow>(PENDING_REPORTS_SQL, context.accountId), context, present),
);

// GET /api/v1/annual_reports/:id: the owner's report of the year, read or not; null for none (Record not found).
export const annualReport = userReadOperation<{ year: string; present: PresentInput }, AnnualReports | null>(
  (db, { year: requested, present }, _viewer, context) => {
    const year = reportYear(requested);
    const row = year === null ? undefined : db.first<ReportRow>(REPORT_SQL, context.accountId, year);
    return row === undefined ? null : presentReports(db, [row], context, present);
  },
);

// POST /api/v1/annual_reports/:id/read: the owner's report marked read at the Store's time; false for none.
export const markAnnualReportRead = userWriteOperation.atStoreTime("storeNow")<
  { year: string; storeNow: number },
  boolean
>((db, { year: requested, storeNow }, viewer) => {
  const year = reportYear(requested);
  return year !== null && db.run(VIEW_REPORT_SQL, viewer.accountId, year, isoAt(storeNow)) > 0;
});
