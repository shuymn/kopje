import type { Db } from "../db/sql";
import { settingProjectionSql } from "../platform/stored-bounds";

// Annual reports (Wrapstodon) as Mastodon 4.7.5 makes them (AnnualReport, Api::V1::AnnualReportsController).

// ---- The campaign

// Whether the operator's `wrapstodon` setting is on: off only when stored 'false' (read through its bound,
// WRAPSTODON_SETTING_BOUNDS); no row is on, Mastodon's default (config/settings.yml). One key read.
export function wrapstodonOn(db: Db): boolean {
  return (
    db.first<{ value: string | null }>(
      `SELECT ${settingProjectionSql("wrapstodon", "value")} AS value FROM instance_settings WHERE name = 'wrapstodon'`,
    )?.value !== "false"
  );
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
