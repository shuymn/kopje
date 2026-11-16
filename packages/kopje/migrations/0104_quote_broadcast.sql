-- Kopje Store schema 0100: whether a received quote's verification work notifies when it moves the quote's state.
-- Never edit after release (checksummed).
--
--   quotes.broadcast  whether the decision of the quote's current work runs the update fan-out when it moves the state
--                     (src/domain/quotes.ts finish): 1 when the work's first verification stands for one Mastodon
--                     broadcasts (a same-version Update that reset nothing, a relayed Delete's recheck), 0 when it does
--                     not (a Create, a newer Update, another root arrival, the reset of an accepted quote, which
--                     notifies at the reset), 2 while a failure that may pass waits for the next verification
--                     (RefetchAndVerifyQuoteWorker's broadcast, unless an Update verifies first). A write that starts a
--                     work assigns 0 or 1, an Update that meets a live work assigns only over 2, a relayed Delete 1 to
--                     an accepted quote's work no round holds (a held work's recheck mark reads as 1 instead), and the
--                     work's end writes 0; a value left on an ended work is never read. The CHECK is its stored bound:
--                     a dump carries the value as it is, and a legacy row takes the default, so a quote the previous
--                     release left mid-work (it had notified at the write-back) decides without notifying again.
--
-- Cost: an ALTER adding a column with a constant default and a CHECK, which SQLite tests against each stored quote; no
-- row is written (the shape of 0094_quote_author_fetches).

ALTER TABLE quotes ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(broadcast) = 'integer' AND broadcast IN (0, 1, 2));
