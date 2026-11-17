-- Kopje Store schema 0112: the hosts deliveries failed to, and the index that drains an unavailable host's lanes
-- (src/domain/delivery-hosts.ts, src/domain/deliveries.ts; RES-4, RES-5, RES-6). Never edit after release
-- (checksummed).
--
-- Kopje follows Mastodon's DeliveryFailureTracker and UnavailableDomain (docs/mastodon-deviations.md, "Unavailable
-- delivery hosts"):
--
--   delivery_hosts           one row per host (delivery-hosts.ts deliveryHost: lowercase ASCII, every trailing dot
--                            dropped) a delivery failed to by its own doing since its last success, or that the
--                            operator stopped. host: within the shared predicate (stored-bounds.ts deliveryHostSql,
--                            the CHECK delivery_hosts_host), so it is its own ASCII text and the listing's cursor
--                            compares it byte for byte. failure_days: the distinct UTC days counted, 0 to 7
--                            (FAILURE_DAYS), with last_failure_day the last of them (a day number of the Store's
--                            clock, at most the day a 2^53 - 1 ms time falls in); 0 and NULL for a host only the
--                            operator stopped. unavailable_since: when the 7th day or the operator's stop made it
--                            unavailable (ms), NULL while it is only failing. drain_lane and drain_id: the drain's
--                            cursor while it gives up the host's queued and pending rows (the lane and id of the last
--                            row a step read, '' and 0 at its start), NULL once it ended; the CHECK
--                            delivery_hosts_drain_cursor keeps the lane on the row's own host (stored-bounds.ts
--                            drainCursorSql), so a dump cannot bring a cursor that names another host's lanes. At most
--                            MAX_DELIVERY_HOSTS (10,000) rows: the trigger delivery_hosts_cap (as
--                            domain/stored-triggers.ts emitTriggers writes it), for every writer and an import; the
--                            writers check the count first.
--   delivery_hosts_idle      the available hosts by their last counted day: the sweep's forgetting (30 idle days)
--                            and the stop's eviction when the table is full.
--   delivery_hosts_draining  the hosts whose drain is under way.
--   deliveries_host_drain    the queued and pending deliveries by the host of their lane (stored-bounds.ts
--                            laneHostSql: the lane's host without its trailing dots, NULL for a lane deliveries.ts
--                            laneOf does not write), then lane and id: the drain's walk, one host at a time. A lane
--                            past LANE_BYTES (268) is outside the index; the claim's check gives such a row up.
--
-- No backfill: no host is tracked before the upgrade.
--
-- Cost: building deliveries_host_drain reads every row of deliveries once and indexes its queued and pending ones (at
-- most MAX_BACKLOG active rows a Store admits, more only by import); the table and its two indexes are empty. A file
-- that creates a table cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every
-- reference of the Store. Measured on the benchmark store of test/bench/migration-cost.ts in workerd's local Durable
-- Object SQLite: see the CHANGELOG entry of this file.

CREATE TABLE delivery_hosts (
  host TEXT NOT NULL PRIMARY KEY CONSTRAINT delivery_hosts_host CHECK (typeof(host) = 'text' AND length(CAST(host AS BLOB)) BETWEEN 3 AND 253
	AND instr(CAST(host AS BLOB), x'00') = 0 AND host NOT GLOB '*[^-.0-9a-z]*' AND host GLOB '?*.?*'
	AND host NOT GLOB '[.-]*' AND host NOT GLOB '*[.-]' AND instr(host, '..') = 0
	AND instr(host, '.-') = 0 AND instr(host, '-.') = 0),
  failure_days INTEGER NOT NULL CONSTRAINT delivery_hosts_days
    CHECK (typeof(failure_days) = 'integer' AND failure_days BETWEEN 0 AND 7),
  last_failure_day INTEGER CONSTRAINT delivery_hosts_day CHECK (last_failure_day IS NULL
    OR (typeof(last_failure_day) = 'integer' AND last_failure_day BETWEEN 0 AND 104249991)),
  unavailable_since INTEGER CONSTRAINT delivery_hosts_since CHECK (unavailable_since IS NULL
    OR (typeof(unavailable_since) = 'integer' AND unavailable_since BETWEEN 0 AND 9007199254740991)),
  drain_lane TEXT,
  drain_id INTEGER CONSTRAINT delivery_hosts_drain_id CHECK (drain_id IS NULL
    OR (typeof(drain_id) = 'integer' AND drain_id >= 0)),
  CONSTRAINT delivery_hosts_state CHECK ((failure_days > 0) = (last_failure_day IS NOT NULL)
    AND (failure_days > 0 OR unavailable_since IS NOT NULL)
    AND (drain_lane IS NULL) = (drain_id IS NULL)
    AND (drain_lane IS NULL OR unavailable_since IS NOT NULL)),
  CONSTRAINT delivery_hosts_drain_cursor CHECK (drain_lane IS NULL OR (drain_lane = '' OR coalesce((CASE WHEN typeof(drain_lane) = 'text' AND length(CAST(drain_lane AS BLOB)) <= 268
	AND instr(CAST(drain_lane AS BLOB), x'00') = 0 AND substr(drain_lane, 1, 8) = 'https://'
	AND substr(drain_lane, 9) NOT GLOB '*[^-.0-9a-z:]*'
	AND (instr(substr(drain_lane, 9), ':') = 0
		OR (substr(substr(drain_lane, 9), instr(substr(drain_lane, 9), ':') + 1) GLOB '[1-9]*'
			AND substr(substr(drain_lane, 9), instr(substr(drain_lane, 9), ':') + 1) NOT GLOB '*[^0-9]*'
			AND length(substr(substr(drain_lane, 9), instr(substr(drain_lane, 9), ':') + 1)) <= 5))
	THEN rtrim(CASE WHEN instr(substr(drain_lane, 9), ':') = 0 THEN substr(drain_lane, 9) ELSE substr(substr(drain_lane, 9), 1, instr(substr(drain_lane, 9), ':') - 1) END, '.') END) = host, 0)))
) WITHOUT ROWID;

CREATE INDEX delivery_hosts_idle ON delivery_hosts (last_failure_day) WHERE unavailable_since IS NULL;
CREATE INDEX delivery_hosts_draining ON delivery_hosts (host) WHERE drain_lane IS NOT NULL;

CREATE INDEX deliveries_host_drain ON deliveries ((CASE WHEN typeof(lane) = 'text' AND length(CAST(lane AS BLOB)) <= 268
	AND instr(CAST(lane AS BLOB), x'00') = 0 AND substr(lane, 1, 8) = 'https://'
	AND substr(lane, 9) NOT GLOB '*[^-.0-9a-z:]*'
	AND (instr(substr(lane, 9), ':') = 0
		OR (substr(substr(lane, 9), instr(substr(lane, 9), ':') + 1) GLOB '[1-9]*'
			AND substr(substr(lane, 9), instr(substr(lane, 9), ':') + 1) NOT GLOB '*[^0-9]*'
			AND length(substr(substr(lane, 9), instr(substr(lane, 9), ':') + 1)) <= 5))
	THEN rtrim(CASE WHEN instr(substr(lane, 9), ':') = 0 THEN substr(lane, 9) ELSE substr(substr(lane, 9), 1, instr(substr(lane, 9), ':') - 1) END, '.') END), lane, id)
WHERE state IN ('queued', 'pending') AND length(CAST(lane AS BLOB)) <= 268;

CREATE TRIGGER delivery_hosts_cap BEFORE INSERT ON delivery_hosts
WHEN NOT EXISTS (SELECT 1 FROM delivery_hosts WHERE host = NEW.host) AND (SELECT count(*) FROM delivery_hosts) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'delivery_hosts: more than 10000');
END;
