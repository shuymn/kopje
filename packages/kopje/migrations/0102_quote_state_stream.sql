-- Kopje Store schema 0100: a quote's state change streams its quoting status. Never edit after release (checksummed).
--
--   stream_quote_state  AFTER UPDATE OF state on quotes, when the state changes: one `edit` event (`status.update`) of
--                       the quoting status (status_id) in the streaming journal, dated by the quote's updated_at, under
--                       the journal's span (JOURNAL_SPAN, 4,096 ids, as every journal trigger) and the listener
--                       condition of stream_status_edited (migration 0056_announcements), which is
--                       src/domain/stream-journal.ts EDIT_LISTENED_SQL (test/migrations.test.ts holds this text to
--                       it). Who is sent the event is judged when it is sent (docs/visibility.md R33): a hidden quoting
--                       status costs the row and is sent to no one. A write that sets the state to its own value
--                       journals nothing; an insert (a new quote, a restored dump, a cutover) fires nothing.
--
-- Every writer that moves a state under a row budget counts the row (docs/threat-model.md RES-6): a revocation batch
-- (src/domain/quotes.ts revocationBatch) three rows a quote, a quoted status's detach (src/domain/inbox.ts
-- STATUS_CHILDREN) four, a retirement (retireQuoteOf) four fixed rows.
--
-- Cost: one trigger made; no row is read or written.

CREATE TRIGGER stream_quote_state AFTER UPDATE OF state ON quotes
WHEN NEW.state IS NOT OLD.state
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at)
  SELECT 'edit', s.id, NEW.updated_at FROM statuses s WHERE s.id = NEW.status_id AND (
    EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;')
    OR (s.visibility = 'public' AND s.reblog_of_id IS NULL
      AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key >= 'public' AND stream_key < 'public;')
        OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'hashtag:' AND stream_key < 'hashtag;'))));
END;
