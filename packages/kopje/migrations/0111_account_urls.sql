-- Kopje Store schema 0111: remote accounts by their stored profile URL. Never edit after release (checksummed).
--
-- Mastodon's mention_link? (app/services/fetch_link_card_service.rb) compares a link with the URL of every account a
-- status mentions. A converted or imported status keeps any number of mention rows, so the link card's mention test
-- starts from the link instead (src/domain/link-cards.ts mentionLink): it finds the remote accounts that store the
-- link as their url through this index, then probes each one's mention by its key.
--
--   accounts_url   remote accounts (domain IS NOT NULL) that store a url, by that url: one entry per such account,
--                  holding its url, at most 2,048 bytes as stored (0048_stored_bounds and the accounts bounds
--                  triggers), and its rowid, so the index holds no more than the column. Not UNIQUE: accounts may
--                  share a url; the mention test reads at most a bounded number of them (MENTION_URL_ACCOUNTS).
--
-- No row is rewritten and no trigger changes. Cost: one pass over accounts to build the partial index; the release
-- notes give its measured time on the benchmark store of test/bench/migration-cost.ts.

CREATE INDEX accounts_url ON accounts (url) WHERE domain IS NOT NULL AND url IS NOT NULL;
