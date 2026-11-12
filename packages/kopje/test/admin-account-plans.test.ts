import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { type AdminAccountFilter, listAdminAccounts } from "../src/domain/admin-accounts";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// RES-7 witnesses of the admin account list's reads that a pin rewrote (each account by its key, each local account
// row by its key), each run side by side with main's statement (MAIN: main's audited SQL, each guarded by its audit
// identity) with the same parameters, in a savepoint rolled back before the rewrite runs, under the plan audit's
// singleton statistics and after ANALYZE. Main's statement is the baseline whose text is the rewrite's with its pins
// taken out: a rewrite that differs from main by more than its pins has none, and fails. Each rewrite returns main's
// rows and reads no more than main after ANALYZE. Its reads stay the same as the remote accounts around its range grow
// on both sides of its keys; a search walks its own range (the accounts it matches, within ADMIN_ACCOUNT_CANDIDATES)
// and grows by its stated rows per account matched. The local accounts stay operator-sized (docs/threat-model.md,
// "Deployment assumptions"). The import-shaped rows: usernames that differ only in case, one username on many domains,
// an IDN domain stored as punycode and one stored raw, a display name with NUL, and ids that tie nowhere (the list's
// order is by id).

const ADMIN = "600000000000000001";
const ADMIN_TOKEN = "admin-accounts-token";
const OTHER = "600000000000000002";
const STATISTICS = ["singleton", "analyzed"] as const;
const FEW = 150;
const MANY = 300;
const PRESENT = { origin: "https://kopje.test" };
const NONE: AdminAccountFilter = {
  origin: null,
  status: null,
  roleIds: null,
  username: null,
  byDomain: null,
  displayName: null,
  email: null,
  ip: null,
  invitedBy: null,
};

// main's audited statements (origin/main as of #1468 group 7), by their audit identity.
const MAIN: Record<string, string> = {
  "87b5a6e097e2f0cb":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY sqlite_autoindex_accounts_1 LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND 1 AND 1 ORDER BY a.id DESC LIMIT ?3",
  da96c2c02866408c:
    "SELECT a.id, a.domain, l.email FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id",
  f3be293181dee3a2:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_active LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND 1 AND (a.deleted_at IS NULL AND a.suspended_at IS NULL) AND (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) ORDER BY a.id DESC LIMIT ?3",
  "84a709feed240a8b":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE NOT l.suspended_at IS NULL",
  "5e93376476b36f62":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_suspended LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.suspended_at IS NOT NULL AND a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) ORDER BY a.id DESC LIMIT ?3",
  aee0f20d53a2d8e7:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_deleted LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.deleted_at IS NOT NULL AND a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) ORDER BY a.id DESC LIMIT ?3",
  "70b8e6d1f272c79d":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY sqlite_autoindex_accounts_1 LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND a.domain IS NOT NULL AND 1 ORDER BY a.id DESC LIMIT ?3",
  "9e86529db4696242":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM local_accounts l JOIN accounts a ON a.id = l.account_id",
  "82fc0e40127c6e76":
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(l.email) >= ?2 AND lower(l.email) < ?3",
  "06ec3b06baf5d9a5":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_username LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) >= ?1 AND lower(a.username) < ?2 LIMIT 2001",
  b0133054d2369745:
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) >= ?2 AND lower(a.username) < ?3",
  "92542d5a04dd9c95":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_domain_username LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.domain = ?1 AND lower(a.username) >= ?2 AND lower(a.username) < ?3 LIMIT 2001",
  "78569b4e54647cc3":
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) >= ?2 AND lower(a.username) < ?3 AND a.domain = ?4",
  "564c8028d796e438":
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_domain_username LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.domain = ?1 LIMIT 2001",
  "86e3b5718de79c79":
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.domain = ?2",
  c692feac604bb9d0:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_display_name LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.display_name) >= ?1 AND lower(a.display_name) < ?2 LIMIT 2001",
  "7511bb5f1914c901":
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.display_name) >= ?2 AND lower(a.display_name) < ?3",
  f6668832891ebeb7:
    "SELECT a.id FROM json_each(?1) c CROSS JOIN accounts a ON a.id = c.value LEFT JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) >= ?2 AND lower(a.username) < ?3 AND lower(a.display_name) >= ?4 AND lower(a.display_name) < ?5",
};

type Side = {
  query: string;
  mine: { rows: number; result: SqlRow[] };
  main: { rows: number; result: SqlRow[] };
};

const ROLLBACK = new Error("rolled back");
const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

// main's statement for a rewrite: the baseline whose text is the rewrite's without its pins (each account by its key,
// each local account by its key), or undefined when none is.
function mainOf(query: string): string | undefined {
  const unpinned = normalized(
    query
      .replace(
        /CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a\.id = c\.value/g,
        "CROSS JOIN accounts a ON a.id = c.value",
      )
      .replace(
        /local_accounts l CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a\.id = l\.account_id/g,
        "local_accounts l JOIN accounts a ON a.id = l.account_id",
      )
      .replace(
        /LEFT JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON/g,
        "LEFT JOIN local_accounts l ON",
      ),
  );
  return Object.values(MAIN).find((sql) => normalized(sql) === unpinned);
}

// The admin list's statements the pins rewrote: its candidates (their availability), and the accounts it presents or
// text-matches. Each must carry a pin: one that runs as main's (a pin taken out) fails.
const LISTED =
  /^SELECT a\.id, a\.domain IS NULL AS local,|^SELECT a\.id(?:, a\.domain, l\.email)? FROM json_each\(\?1\) c CROSS JOIN accounts a /;

// A SqlStorage over `real` that, for each of the list's statements, first runs main's with the same parameters in a
// nested transaction it rolls back, then the statement itself, recording both one `Side`.
function sideBySide(real: SqlStorage, transact: <T>(fn: () => T) => T, sides: Side[]): SqlStorage {
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      if (!LISTED.test(normalized(query))) {
        return real.exec(query, ...params);
      }
      const main = mainOf(query);
      if (main === undefined) {
        throw new Error(`no baseline of main's for ${normalized(query)}`);
      }
      if (normalized(main) === normalized(query)) {
        throw new Error(`main's statement, unpinned: ${normalized(query)}`);
      }
      const side: Side = { query, mine: { rows: 0, result: [] }, main: { rows: 0, result: [] } };
      try {
        transact(() => {
          const cursor = real.exec<SqlRow>(main, ...params);
          side.main.result = cursor.toArray();
          side.main.rows = cursor.rowsRead;
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) {
          throw error;
        }
      }
      sides.push(side);
      const cursor = real.exec<SqlRow>(query, ...params);
      return watchedCursor(
        cursor,
        () => (side.mine.rows += cursor.rowsRead),
        (rows) => (side.mine.result = rows),
      );
    },
  } as unknown as SqlStorage;
}

// The admin (the OAuth admin, its token) and another local account; `n` remote accounts on each side of the search
// range's ids and names (usernames m… and z…, display names likewise, on domains d….example), one in five suspended
// and one in five whose deletion has started; and the import-shaped accounts: usernames ab, AB, Ab and abc on
// several domains, an IDN domain stored as punycode and as raw text, a display name with NUL.
async function world(n: number, own = 0): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO instance_settings (name, value) VALUES ('admin_email', 'admin@example.com')");
    for (const [id, name] of [
      [ADMIN, "admin"],
      [OTHER, "other"],
    ]) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
        id,
        `https://kopje.test/ap/users/${name}`,
        name,
      );
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')`,
        id,
        `${name}@example.com`,
      );
    }
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('admin', 's', 'admin', 'urn:ietf:wg:oauth:2.0:oob', 'admin:read')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'admin', ?, 'admin:read')",
      ADMIN_TOKEN,
      ADMIN,
    );
    const at = new Date(NOW).toISOString();
    const side = (base: string, prefix: string) =>
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, display_name, deleted_at, suspended_at, suspension_source)
				SELECT CAST(?2 + i AS TEXT), 'https://d' || (i % 7) || '.example/users/' || ?3 || i, ?3 || i,
					'd' || (i % 7) || '.example', ?3 || ' ' || i,
					CASE WHEN i % 5 = 1 THEN ?4 END, CASE WHEN i % 5 = 2 THEN ?4 END, CASE WHEN i % 5 = 2 THEN 'account' END
				FROM n`,
        n,
        base,
        prefix,
        at,
      );
    side("500000000000000000", "m");
    const shaped: [string, string, string | null, string][] = [
      ["ab", "d1.example", "ab", "550000000000000001"],
      ["AB", "d2.example", "AB", "550000000000000002"],
      ["Ab", "xn--bcher-kva.example", "Ab\u0000hidden", "550000000000000003"],
      ["abc", "bücher.example", "abc", "550000000000000004"],
      ["abd", "d1.example", null, "550000000000000005"],
    ];
    for (const [username, domain, display, id] of shaped) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username, domain, display_name) VALUES (?, ?, ?, ?, ?)",
        id,
        `https://${domain}/users/${username}`,
        username,
        domain,
        display ?? "",
      );
    }
    // The search's own range grown: `own` more accounts named ab… on d3.example.
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, display_name)
			SELECT CAST(560000000000000000 + i AS TEXT), 'https://d3.example/users/ab_' || i, 'ab_' || i, 'd3.example',
				'ab ' || i FROM n WHERE ?1 > 0`,
      own,
    );
    side("700000000000000000", "z");
  });
  return store;
}

type Case = {
  filter: Partial<AdminAccountFilter>;
  // The rewrite's rows read per account its own range gains, for a search that walks it; absent: it reads none of it.
  walks?: number;
};

const CASES: Record<string, Case> = {
  "every account": { filter: {} },
  "the active accounts": { filter: { status: "active" } },
  "the suspended accounts": { filter: { status: "suspended" } },
  "the remote accounts": { filter: { origin: "remote" } },
  "the local accounts": { filter: { origin: "local" } },
  "an email prefix": { filter: { email: "ADMIN" } },
  "a username prefix, folded": { filter: { username: "aB" }, walks: 3 },
  "a username prefix on a domain": { filter: { username: "ab", byDomain: "d3.example" }, walks: 3 },
  "an IDN domain as stored": { filter: { byDomain: "xn--bcher-kva.example" } },
  "a display name prefix": { filter: { displayName: "AB" }, walks: 3 },
  "a username and a display name": { filter: { username: "ab", displayName: "ab" }, walks: 4 },
};

async function sides(statistics: (typeof STATISTICS)[number], c: Case, n: number, own: number) {
  const store = await world(n, own);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const accounts = sql.exec<{ n: number }>("SELECT count(*) AS n FROM accounts").one().n;
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    const out: Side[] = [];
    const answer = transact(() =>
      listAdminAccounts.run(sideBySide(sql, transact, out), {
        credential: { tokenHash: ADMIN_TOKEN, scope: "admin:read:accounts", now: NOW },
        filter: { ...NONE, ...c.filter },
        page: { limit: 20 },
        present: PRESENT,
      }),
    );
    return { sides: out, accounts, answer };
  });
}

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    expect(Object.keys(MAIN).length).toBeGreaterThan(0);
    for (const [id, sql] of Object.entries(MAIN)) {
      expect(await statementId(sql), sql).toBe(id);
    }
  });
});

describe("admin account reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const c = CASES[name]!;
      // The neighbours grow (the search's own range held), then the search's own range grows (the neighbours held).
      const few = await sides(statistics, c, FEW, 0);
      const many = await sides(statistics, c, MANY, 0);
      const ownFew = await sides(statistics, c, FEW, 100);
      const ownMany = await sides(statistics, c, FEW, 200);
      for (const [small, large] of [
        [few, many],
        [ownFew, ownMany],
      ] as const) {
        expect(large.accounts).toBeGreaterThan(small.accounts);
        expect(small.sides.length).toBeGreaterThan(0);
        expect(large.sides.length).toBe(small.sides.length);
        for (const run of [small, large]) {
          expect(run.answer.status).toBe("ok");
          for (const side of run.sides) {
            expect(side.mine.result, side.query).toEqual(side.main.result);
            if (statistics === "analyzed") {
              expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
            }
          }
        }
      }
      // The neighbours: the same rows.
      expect(many.sides.map((s) => s.mine.rows)).toEqual(few.sides.map((s) => s.mine.rows));
      // The own range: at most `walks` rows per account it gains.
      for (const [i, side] of ownMany.sides.entries()) {
        const grown = side.mine.rows - ownFew.sides[i]!.mine.rows;
        expect(grown, side.query).toBeGreaterThanOrEqual(0);
        expect(grown, side.query).toBeLessThanOrEqual((c.walks ?? 0) * 100);
      }
    },
    120_000,
  );
});
