-- Kopje Store schema 0096: profile image descriptions and display settings. Never edit after release (checksummed).
--
--   accounts.avatar_description   the account's image descriptions (Mastodon's avatar_description and
--   accounts.header_description   header_description, app/models/concerns/account/avatar.rb and header.rb): text of
--                                 at most PROFILE_DESCRIPTION_LIMIT (150) characters, '' for none. Written by
--                                 update_credentials and the settings page (a local one validated at 150 code
--                                 points); independent of the image, as in Mastodon: removing or replacing an image
--                                 keeps its description.
--   accounts.show_featured        the account's display settings (Mastodon's show_featured, show_media and
--   accounts.show_media           show_media_replies, app/models/account.rb): the integer 0 or 1, 1 by default, as
--   accounts.show_media_replies   Mastodon's schema has them; presented, and enforced by nothing on the server.
--   accounts_profile_settings_insert   BEFORE INSERT and BEFORE UPDATE OF the five columns on accounts:
--   accounts_profile_settings_update   RAISE(ABORT, 'accounts: profile setting past its stored bound') for a
--                                 description that is not text of at most 600 bytes, without NUL, of at most 150
--                                 characters, or a setting that is not the integer 0 or 1. Column affinity is applied
--                                 before the trigger reads NEW: a setting written as numeric text ('1', ' 1') is
--                                 stored as the integer, and a description written as a number as its text. NULL
--                                 reaches the trigger before NOT NULL, so its refusal carries the trigger's message.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (PROFILE_DESCRIPTION_LIMIT, PROFILE_DESCRIPTION_BYTES,
-- profileSettingsPastBoundSql); the statements after the columns are the output of src/domain/stored-triggers.ts
-- (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: each column has a constant default and no CHECK, so adding it reads and rewrites no row; the triggers read no
-- row.

ALTER TABLE accounts ADD COLUMN avatar_description TEXT NOT NULL DEFAULT '';

ALTER TABLE accounts ADD COLUMN header_description TEXT NOT NULL DEFAULT '';

ALTER TABLE accounts ADD COLUMN show_featured INTEGER NOT NULL DEFAULT 1;

ALTER TABLE accounts ADD COLUMN show_media INTEGER NOT NULL DEFAULT 1;

ALTER TABLE accounts ADD COLUMN show_media_replies INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER accounts_profile_settings_insert BEFORE INSERT ON accounts
WHEN CASE WHEN typeof(NEW.avatar_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.avatar_description AS BLOB)) > 600 THEN 1
	WHEN instr(CAST(NEW.avatar_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(NEW.avatar_description) > 150 THEN 1
	WHEN typeof(NEW.header_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.header_description AS BLOB)) > 600 THEN 1
	WHEN instr(CAST(NEW.header_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(NEW.header_description) > 150 THEN 1
	WHEN typeof(NEW.show_featured) <> 'integer' THEN 1
	WHEN NEW.show_featured NOT IN (0, 1) THEN 1
	WHEN typeof(NEW.show_media) <> 'integer' THEN 1
	WHEN NEW.show_media NOT IN (0, 1) THEN 1
	WHEN typeof(NEW.show_media_replies) <> 'integer' THEN 1
	WHEN NEW.show_media_replies NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: profile setting past its stored bound');
END;

CREATE TRIGGER accounts_profile_settings_update BEFORE UPDATE OF avatar_description, header_description, show_featured, show_media, show_media_replies ON accounts
WHEN CASE WHEN typeof(NEW.avatar_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.avatar_description AS BLOB)) > 600 THEN 1
	WHEN instr(CAST(NEW.avatar_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(NEW.avatar_description) > 150 THEN 1
	WHEN typeof(NEW.header_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.header_description AS BLOB)) > 600 THEN 1
	WHEN instr(CAST(NEW.header_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(NEW.header_description) > 150 THEN 1
	WHEN typeof(NEW.show_featured) <> 'integer' THEN 1
	WHEN NEW.show_featured NOT IN (0, 1) THEN 1
	WHEN typeof(NEW.show_media) <> 'integer' THEN 1
	WHEN NEW.show_media NOT IN (0, 1) THEN 1
	WHEN typeof(NEW.show_media_replies) <> 'integer' THEN 1
	WHEN NEW.show_media_replies NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: profile setting past its stored bound');
END;
