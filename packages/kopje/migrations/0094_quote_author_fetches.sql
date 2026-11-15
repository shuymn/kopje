-- Kopje Store schema 0094: the author documents a received quote's verification applied. Never edit after release
-- (checksummed).
--
--   quotes.author_fetches  the author stages of the quote's current work that stored, refreshed or stamped the quoted
--                          status's author (src/domain/quotes.ts QUOTE_AUTHOR_FETCHES, 6: the figure of its attempts,
--                          1 + QUOTE_BACKOFF_MS.length). An author stage with none left ends the work without a fetch,
--                          so one quoted status brings at most 6 author documents however its rounds end
--                          (docs/threat-model.md RES-6). Set to 0 with attempts when the work is renewed (promoteQuote,
--                          recordQuote). The CHECK is its stored bound, an integer so that the increment stays within
--                          it: a dump carries the value as it is, and a legacy row takes the default.
--
-- Cost: an ALTER adding a column with a constant default and a CHECK, which SQLite tests against each stored quote; no
-- row is written. Measured on the benchmark store of test/bench/migration-cost.ts (its 400,000 quotes, received and
-- local) in workerd's local Durable Object SQLite, the Store's reference check skipped as declared, one run: 745 ms for
-- the upgrade of this file through the kernel, at a load average of about 30 to 40.

ALTER TABLE quotes ADD COLUMN author_fetches INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(author_fetches) = 'integer' AND author_fetches BETWEEN 0 AND 6);
