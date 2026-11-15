-- Kopje Store schema 0098: a link card's unverified author (Mastodon 4.6's PreviewCard#unverified_author_account, which
-- REST::PreviewCardSerializer presents as missing_attribution). Never edit after release (checksummed).
--
--   status_cards.unverified_author_account_id   NULL, or the local account the card's page names as its
--                                 fediverse:creator when none of that account's attribution domains covers the page's
--                                 host (src/domain/link-cards.ts recordCard): 18 ASCII digits as TEXT, NULL on a
--                                 pending row. No foreign key: an account id is never reused, and a deleted account's
--                                 matches no viewer. Every existing row holds NULL; no row is rewritten.
--   status_cards_bounds_insert    dropped and recreated over every column, the new one included: 0071's cases, then an
--   status_cards_bounds_update    author that is not 18 ASCII digits as TEXT (the storage class, the bytes, NUL, the
--                                 digits), and an author on a pending row. No trigger writes.
--
-- Bounds and the predicates: src/platform/stored-bounds.ts (cardAuthorPastSql, statusCardPastBoundSql); the statements
-- below are the output of cardAttributionMigrationSql and of src/domain/stored-triggers.ts (test/migrations.test.ts
-- compares them); stored form: docs/dump-format.md.
--
-- Cost: the column, without a default or a CHECK, is added to the schema only, and the triggers read no row. Their
-- text names main.statuses, which a file declared foreignKeys: 'unchanged' may not (test/migration-sql.ts), so the
-- upgrade checks every reference of the Store. Measured on the benchmark store of test/bench/migration-cost.ts (its
-- 200,000 attached cards and 10,000 pending ones) in workerd's local Durable Object SQLite: see the CHANGELOG entry of
-- this file.

ALTER TABLE status_cards ADD COLUMN unverified_author_account_id TEXT;

DROP TRIGGER status_cards_bounds_insert;
DROP TRIGGER status_cards_bounds_update;

CREATE TRIGGER status_cards_bounds_insert BEFORE INSERT ON status_cards
WHEN CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\^`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.image_url IS NOT '' AND CASE WHEN typeof(NEW.image_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.image_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.image_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.image_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.image_id IS NOT NULL AND CASE WHEN typeof(NEW.image_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.image_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.image_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_description AS BLOB)) > 254 THEN 1
	WHEN instr(CAST(NEW.image_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.image_description) AS BLOB)) > 256 THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.link_type) <> 'integer' OR NEW.link_type NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.final_url IS NOT '' AND CASE WHEN typeof(NEW.final_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.final_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.final_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.final_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.final_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.final_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.public) <> 'integer' OR NEW.public NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.unverified_author_account_id IS NOT NULL AND CASE WHEN typeof(NEW.unverified_author_account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.unverified_author_account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.unverified_author_account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.unverified_author_account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	WHEN NEW.public = 1 AND (NEW.fetched_at IS NULL OR NEW.final_url = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = NEW.status_id) IS NOT 'public') THEN 1
	WHEN NEW.unverified_author_account_id IS NOT NULL AND NEW.fetched_at IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TRIGGER status_cards_bounds_update BEFORE UPDATE OF status_id, url, due_at, enqueued_at, claim, attempts, generation, title, description, author_name, author_url, provider_name, provider_url, language, published_at, fetched_at, card_type, width, height, embed_src, iframe_width, iframe_height, image_url, image_id, image_description, link_type, final_url, public, unverified_author_account_id ON status_cards
WHEN CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\^`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.image_url IS NOT '' AND CASE WHEN typeof(NEW.image_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.image_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.image_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.image_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.image_id IS NOT NULL AND CASE WHEN typeof(NEW.image_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.image_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.image_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_description AS BLOB)) > 254 THEN 1
	WHEN instr(CAST(NEW.image_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.image_description) AS BLOB)) > 256 THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.link_type) <> 'integer' OR NEW.link_type NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.final_url IS NOT '' AND CASE WHEN typeof(NEW.final_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.final_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.final_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.final_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.final_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.final_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.public) <> 'integer' OR NEW.public NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.unverified_author_account_id IS NOT NULL AND CASE WHEN typeof(NEW.unverified_author_account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.unverified_author_account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.unverified_author_account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.unverified_author_account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	WHEN NEW.public = 1 AND (NEW.fetched_at IS NULL OR NEW.final_url = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = NEW.status_id) IS NOT 'public') THEN 1
	WHEN NEW.unverified_author_account_id IS NOT NULL AND NEW.fetched_at IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;
