-- Kopje Store schema 0090: the conversation stream sequence never leaves the INTEGERs. Never edit after release
-- (checksummed).
--
--   conversation_statuses_removed   as 0032_streaming_lists made it, with one statement first: when the status removed
--                                   is its conversation's last and others remain, so that the owner's mark
--                                   (stream_conversation_marks.seq) moves on, and the mark has no next INTEGER (it
--                                   holds 2^63 - 1, or a value not stored as one), RAISE(ABORT, 'the owner''s
--                                   conversation stream sequence is exhausted'). Before, seq + 1 stored a REAL there,
--                                   which conversations.stream_seq copied and the streaming journal then compared as a
--                                   double (DATA-6). The writers in JavaScript refuse the same increment
--                                   (requireExactIncrement in src/domain/conversations.ts, nextStreamSeq).
--
-- A mark starts at the owner's largest conversations.stream_seq (streamRegister in src/domain/streaming.ts), so only a
-- restored Store whose stream_seq is the largest INTEGER reaches the limit; a delete of such an owner's last
-- conversation status then fails and rolls back, as that owner's other conversation writes already do. Marks are
-- streaming state, never dumped; no existing row is read or rewritten.
--
-- Cost: the trigger is dropped and made again; no row is read. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite, the Store's reference check skipped as
-- declared: 2 ms for the upgrade of this file through the kernel, at a load average of about 6 to 16.

DROP TRIGGER conversation_statuses_removed;

CREATE TRIGGER conversation_statuses_removed AFTER DELETE ON conversation_statuses
WHEN EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id)
BEGIN
  SELECT RAISE(ABORT, 'the owner''s conversation stream sequence is exhausted')
    FROM stream_conversation_marks
    WHERE account_id = (SELECT account_id FROM conversations WHERE id = OLD.conversation_id
        AND last_status_id = OLD.status_id)
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id)
      AND typeof(seq + 1) <> 'integer';
  UPDATE stream_conversation_marks SET seq = seq + 1
    WHERE account_id = (SELECT account_id FROM conversations WHERE id = OLD.conversation_id
        AND last_status_id = OLD.status_id)
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
  UPDATE conversations
    SET last_status_id = (SELECT max(status_id) FROM conversation_statuses WHERE conversation_id = OLD.conversation_id),
      stream_seq = coalesce((SELECT m.seq FROM stream_conversation_marks m WHERE m.account_id = conversations.account_id),
        stream_seq)
    WHERE id = OLD.conversation_id AND last_status_id = OLD.status_id
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
  DELETE FROM conversations WHERE id = OLD.conversation_id
    AND NOT EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
END;
