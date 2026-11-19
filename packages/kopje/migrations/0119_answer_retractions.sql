-- Kopje Store schema 0119: the unsuperseded retractions of each subject as one range (#1589). Never edit after release
-- (checksummed).
--
--   outbound_activities_unsuperseded_retractions   outbound_activities by (account_id, object_uri, id), only the rows
--                                                  neither superseded nor anything but a retraction: the latest
--                                                  retraction answer of a feature authorization to one owner
--                                                  (src/domain/deliveries.ts LATEST_ANSWER: the coalescing gate, the
--                                                  cancellation's lookup and supersedeAnswer) is one probe of it, since
--                                                  each retraction answer supersedes the one before it. Through
--                                                  outbound_activities_unsuperseded these also walked the subject's
--                                                  unsuperseded ordinary answers, which no cap bounds.
--
-- No row is rewritten and no trigger changes. Cost: one pass over outbound_activities to build the index, which holds
-- an entry only for an unsuperseded retraction.

CREATE INDEX outbound_activities_unsuperseded_retractions ON outbound_activities (account_id, object_uri, id)
	WHERE superseded = 0 AND retracts = 1;
