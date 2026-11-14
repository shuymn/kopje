-- Kopje Store schema 0093: annual reports (Mastodon 4.7.5's GeneratedAnnualReport, schema 2, for
-- /api/v1/annual_reports; src/domain/annual-reports.ts). Never edit after release (checksummed).
--
--   annual_reports                one row per local account and year: the report's four sources as generated
--                                 (archetype; the year's statuses and followers; the top status by boosts, NULL when
--                                 none; the top hashtag and its uses, both NULL when none), viewed_at (NULL while
--                                 pending, then when the owner marked it read) and created_at (when it was computed),
--                                 both on the Store's clock. The account's delete cascades to its reports.
--   annual_reports_pending        the owner's pending reports by year, for the list.
--   instance_settings_wrapstodon_insert   BEFORE INSERT and BEFORE UPDATE OF name, value on instance_settings:
--   instance_settings_wrapstodon_update   RAISE(ABORT, 'instance_settings: a value past its stored bound') for a
--                                 wrapstodon that is not 'true' or 'false'.
--   instance_settings             an existing wrapstodon row that is neither is deleted first, so it reads as absent
--                                 (on); none is rewritten.
--
-- Bounds (src/platform/stored-bounds.ts ANNUAL_REPORT_ARCHETYPES, ANNUAL_REPORT_YEARS, SAFE_INTEGER_MAX,
-- isoTimeWhen, WRAPSTODON_SETTING_BOUNDS; src/domain/status-bounds.ts TAG_NAME_BYTES, MAX_TAG_LENGTH): year an
-- integer from 1 to 9999; archetype one of five words; the counts integers from 0, the uses from 2, to 2^53 - 1;
-- top_status_id 18 ASCII digits; top_hashtag 1 to TAG_NAME_BYTES raw bytes, no NUL, at most MAX_TAG_LENGTH characters;
-- the times Kopje's 24-byte form. The statements below are the output of annualReportsMigrationSql and of
-- src/domain/stored-triggers.ts (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the table and its index are new and empty, the DELETE seeks one instance_settings row by its key, and the
-- triggers read no row. A file that creates a table cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts),
-- so its upgrade checks every reference of the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE annual_reports (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  year INTEGER NOT NULL CONSTRAINT annual_report_year CHECK ((CASE
      WHEN typeof(year) <> 'integer' THEN 0
      WHEN year BETWEEN 1 AND 9999 THEN 1
      ELSE 0 END) = 1),
  archetype TEXT NOT NULL CONSTRAINT annual_report_archetype CHECK ((CASE
      WHEN typeof(archetype) <> 'text' THEN 0
      WHEN length(CAST(archetype AS BLOB)) > 8 THEN 0
      WHEN instr(CAST(archetype AS BLOB), x'00') > 0 THEN 0
      WHEN archetype IN ('lurker', 'booster', 'pollster', 'replier', 'oracle') THEN 1
      ELSE 0 END) = 1),
  statuses INTEGER NOT NULL CONSTRAINT annual_report_statuses CHECK ((CASE
      WHEN typeof(statuses) <> 'integer' THEN 0
      WHEN statuses BETWEEN 0 AND 9007199254740991 THEN 1
      ELSE 0 END) = 1),
  followers INTEGER NOT NULL CONSTRAINT annual_report_followers CHECK ((CASE
      WHEN typeof(followers) <> 'integer' THEN 0
      WHEN followers BETWEEN 0 AND 9007199254740991 THEN 1
      ELSE 0 END) = 1),
  top_status_id TEXT CONSTRAINT annual_report_top_status_id CHECK ((CASE
      WHEN top_status_id IS NULL THEN 1
      WHEN typeof(top_status_id) <> 'text' THEN 0
      WHEN length(CAST(top_status_id AS BLOB)) <> 18 THEN 0
      WHEN instr(CAST(top_status_id AS BLOB), x'00') > 0 THEN 0
      WHEN top_status_id NOT GLOB '*[^0-9]*' THEN 1
      ELSE 0 END) = 1),
  top_hashtag TEXT CONSTRAINT annual_report_top_hashtag CHECK ((CASE
      WHEN top_hashtag IS NULL THEN 1
      WHEN typeof(top_hashtag) <> 'text' THEN 0
      WHEN length(CAST(top_hashtag AS BLOB)) NOT BETWEEN 1 AND 1024 THEN 0
      WHEN instr(CAST(top_hashtag AS BLOB), x'00') > 0 THEN 0
      WHEN length(top_hashtag) <= 256 THEN 1
      ELSE 0 END) = 1),
  top_hashtag_uses INTEGER CONSTRAINT annual_report_top_hashtag_uses CHECK ((CASE
      WHEN top_hashtag_uses IS NULL THEN 1
      WHEN typeof(top_hashtag_uses) <> 'integer' THEN 0
      WHEN top_hashtag_uses BETWEEN 2 AND 9007199254740991 THEN 1
      ELSE 0 END) = 1),
  viewed_at TEXT CONSTRAINT annual_report_viewed_at CHECK ((CASE
      WHEN viewed_at IS NULL THEN 1
      WHEN typeof(viewed_at) <> 'text' THEN 0
      WHEN length(CAST(viewed_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(viewed_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(viewed_at AS BLOB)) = 24 AND substr(viewed_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', viewed_at) = viewed_at THEN 1
      ELSE 0 END) = 1),
  created_at TEXT NOT NULL CONSTRAINT annual_report_created_at CHECK ((CASE
      WHEN typeof(created_at) <> 'text' THEN 0
      WHEN length(CAST(created_at AS BLOB)) <> 24 THEN 0
      WHEN instr(CAST(created_at AS BLOB), x'00') > 0 THEN 0
      WHEN length(CAST(created_at AS BLOB)) = 24 AND substr(created_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at THEN 1
      ELSE 0 END) = 1),
  CONSTRAINT annual_report_top_hashtag_pair CHECK ((CASE
      WHEN top_hashtag IS NULL AND top_hashtag_uses IS NULL THEN 1
      WHEN top_hashtag IS NOT NULL AND top_hashtag_uses IS NOT NULL THEN 1
      ELSE 0 END) = 1),
  PRIMARY KEY (account_id, year)
) WITHOUT ROWID;

CREATE INDEX annual_reports_pending ON annual_reports (account_id, year) WHERE viewed_at IS NULL;

DELETE FROM instance_settings
WHERE name = 'wrapstodon' AND value IS NOT 'true' AND value IS NOT 'false';

-- 0049's triggers end in ELSE 0, and 0057's, 0059's and 0072's name other settings; these bound wrapstodon.

CREATE TRIGGER instance_settings_wrapstodon_insert BEFORE INSERT ON instance_settings
WHEN NEW.name = 'wrapstodon' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE TRIGGER instance_settings_wrapstodon_update BEFORE UPDATE OF name, value ON instance_settings
WHEN NEW.name = 'wrapstodon' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;
