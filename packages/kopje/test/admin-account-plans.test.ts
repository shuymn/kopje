import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { type AdminAccountFilter, listAdminAccounts } from "../src/domain/admin-accounts";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";

// RES-7 witnesses of the admin account list's reads that a pin rewrote (each account by its key, each local account row
// by its key), each run beside main's statement by test/plan-witness.ts (WITNESS: main's audited SQL, its rewrite the
// baseline with pins added; every statement of the list's must be one), under the plan audit's singleton statistics and
// after ANALYZE. Each case names main's statements its list runs, in order. Each returns main's rows and reads no more
// than main after ANALYZE. Its reads stay the same as the remote accounts around its range grow on both sides of its
// keys; a search walks its own range (the accounts it matches, within ADMIN_ACCOUNT_CANDIDATES), counted by the
// search's own predicate, and grows by at least one and at most its stated rows per account the range gains. The local
// accounts stay operator-sized (docs/threat-model.md, "Deployment assumptions"). The import-shaped rows: usernames that
// differ only in case, one username on many domains, an IDN domain stored as punycode and one stored raw, a display
// name with NUL; the list's order is by id, so it has no ties.

const ADMIN = "600000000000000001";
const ADMIN_TOKEN = "admin-accounts-token";
const OTHER = "600000000000000002";
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
  bd9046d277ce1943:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY sqlite_autoindex_accounts_1 LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND a.domain IS NOT NULL AND 1 ORDER BY a.id ASC LIMIT ?3",
  e2e93a1a778c9707:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY sqlite_autoindex_accounts_1 LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND 1 AND 1 ORDER BY a.id ASC LIMIT ?3",
  d3a51ed21b532871:
    "SELECT a.id, a.domain IS NULL AS local, NOT (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS unavailable FROM accounts a INDEXED BY accounts_active LEFT JOIN local_accounts l ON l.account_id = a.id WHERE a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47)) AND a.domain IS NOT NULL AND (a.deleted_at IS NULL AND a.suspended_at IS NULL) AND (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) ORDER BY a.id DESC LIMIT ?3",
};

const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();

// The rewrite without its pins (each account by its key, each local account by its key): main's statement exactly.
function unpinned(query: string): string {
  return normalized(
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
}

// The admin list's statements the pins rewrote: its candidates (their availability), and the accounts it presents or
// text-matches.
const LISTED =
  /^SELECT a\.id, a\.domain IS NULL AS local,|^SELECT a\.id(?:, a\.domain, l\.email)? FROM json_each\(\?1\) c CROSS JOIN accounts a /;

// Every other statement the flows make, literally: PlanWitness's allowed list, so a statement the witness does not
// measure fails the case.
const OTHER_STATEMENTS = [
  "SELECT 1 AS x FROM remote_moderation_jobs WHERE kind = 'domain' AND subject = ''",
  "SELECT a.id AS id, CASE WHEN length(CAST(a.uri AS BLOB)) <= 2048 THEN a.uri ELSE '' END AS uri, CASE WHEN length(CAST(a.username AS BLOB)) = length(a.username) AND a.username NOT GLOB '*[^A-Za-z0-9_.-]*' THEN CASE WHEN length(CAST(a.username AS BLOB)) <= 255 THEN a.username ELSE substr(a.username, 1, 255) END ELSE substr(a.username, 1, 42) END AS username, a.domain AS domain, a.actor_type AS actor_type, a.display_name AS display_name, a.note AS note, a.url AS url, a.avatar_url AS avatar_url, a.header_url AS header_url, a.avatar_static_url AS avatar_static_url, a.header_static_url AS header_static_url, a.locked AS locked, a.discoverable AS discoverable, a.indexable AS indexable, CASE WHEN typeof(a.followers_count) = 'integer' AND a.followers_count BETWEEN 0 AND 9007199254740991 THEN a.followers_count ELSE 0 END AS followers_count, CASE WHEN typeof(a.following_count) = 'integer' AND a.following_count BETWEEN 0 AND 9007199254740991 THEN a.following_count ELSE 0 END AS following_count, CASE WHEN typeof(a.statuses_count) = 'integer' AND a.statuses_count BETWEEN 0 AND 9007199254740991 THEN a.statuses_count ELSE 0 END AS statuses_count, a.created_at AS created_at, (l.suspended_at IS NULL AND a.deleted_at IS NULL AND NOT (a.suspended_at IS NOT NULL AND a.suspension_source = 'account') AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(a.domain, '.') ELSE rtrim(lower(substr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(a.uri, instr(a.uri, '://') + 3), 1, instr(substr(a.uri, instr(a.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE a.domain IS NOT NULL), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AS available, (SELECT substr(coalesce(CASE WHEN octet_length(s.published_at) > 64 THEN NULL WHEN length(CAST(s.published_at AS BLOB)) = 24 AND substr(s.published_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at) = s.published_at THEN s.published_at WHEN instr(CAST(s.published_at AS BLOB), x'00') = 0 AND s.published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds'), 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') END) END, CASE WHEN octet_length(s.created_at) > 64 THEN NULL WHEN length(CAST(s.created_at AS BLOB)) = 24 AND substr(s.created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at) = s.created_at THEN s.created_at WHEN instr(CAST(s.created_at AS BLOB), x'00') = 0 AND s.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds'), 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') END) END, '1970-01-01T00:00:00.000Z'), 1, 10) FROM statuses s WHERE s.account_id = a.id AND s.visibility IN ('public', 'unlisted', 'private') ORDER BY s.id DESC LIMIT 1) AS last_status_at, CASE WHEN typeof(l.fields) = 'text' AND length(CAST(l.fields AS BLOB)) <= 16384 AND instr(CAST(l.fields AS BLOB), x'00') = 0 THEN l.fields END AS local_fields, CASE WHEN CASE WHEN typeof(l.fields) = 'text' AND length(CAST(l.fields AS BLOB)) <= 16384 AND instr(CAST(l.fields AS BLOB), x'00') = 0 AND json_valid(l.fields) AND json_type(l.fields) = 'array' AND json_array_length(l.fields) <= 4 THEN l.fields END IS NOT NULL THEN l.verified_links END AS verified_links, COALESCE(l.hide_collections, a.hide_collections) AS hide_collections, CASE WHEN a.domain IS NOT NULL THEN ( SELECT '[' || COALESCE(group_concat(k.entry, ',' ORDER BY k.key), '') || ']' FROM (SELECT c.key, c.entry, 1 + sum(length(CAST(c.entry AS BLOB)) + 1) OVER (ORDER BY c.key) AS size FROM (SELECT e.key, json_object('name', CASE WHEN length(CAST(e.value ->> '$.name' AS BLOB)) <= 255 THEN e.value ->> '$.name' ELSE substr(e.value ->> '$.name', 1, 255) END, 'value', CASE WHEN length(CAST(e.value ->> '$.value' AS BLOB)) <= 4096 THEN e.value ->> '$.value' ELSE substr(e.value ->> '$.value', 1, 4096) END) AS entry FROM json_each(CASE json_type(a.raw, '$.attachment') WHEN 'array' THEN a.raw -> '$.attachment' ELSE json_array(a.raw -> '$.attachment') END) e WHERE e.type = 'object' AND json_type(e.value, '$.name') = 'text' AND json_type(e.value, '$.value') = 'text' AND json_type(e.value, '$.type') IN ('text', 'array') AND EXISTS (SELECT 1 FROM json_each(e.value, '$.type') t WHERE t.type = 'text' AND t.value = 'PropertyValue') ORDER BY e.key LIMIT 16) c) k WHERE k.size <= 32768) END AS attachment, CASE WHEN a.domain IS NOT NULL THEN (SELECT CASE WHEN typeof(r.links) = 'text' AND length(CAST(r.links AS BLOB)) <= 4213 AND instr(CAST(r.links AS BLOB), x'00') = 0 AND json_valid(r.links) AND json_type(r.links) = 'array' THEN (SELECT json_group_array(json_array(rt.i, rt.t) ORDER BY rt.k) FROM (SELECT e.key AS k, e.value ->> '$[0]' AS i, e.value ->> '$[2]' AS t FROM json_each(r.links) e WHERE e.type = 'array' AND json_type(e.value, '$[0]') = 'integer' AND json_type(e.value, '$[2]') = 'text' ORDER BY e.key LIMIT 4) rt WHERE rt.i BETWEEN 0 AND 15 AND (CASE WHEN length(CAST(rt.t AS BLOB)) = 24 AND substr(rt.t, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', rt.t) = rt.t THEN rt.t END) IS NOT NULL) END FROM remote_field_links r WHERE r.account_id = a.id) END AS remote_verified, a.emojis AS emojis, CASE WHEN a.domain IS NOT NULL AND a.emojis IS NOT NULL THEN (SELECT json_group_array(json_array(ee.key, ce.token || ':' || ce.ext || ':' || COALESCE(ce.still_ext, ''))) FROM json_each(a.emojis) ee CROSS JOIN remote_media ce INDEXED BY remote_media_emoji ON ce.kind = 'emoji' AND ce.domain = a.domain AND ce.url = json_extract(ee.value, '$[1]') WHERE ee.key < 16 AND ce.token IS NOT NULL) END AS emoji_cache, a.moved_to_account_id AS moved_to_account_id FROM json_each(?1) c CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = c.value LEFT JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON l.account_id = a.id",
  "SELECT cm.owner_id AS owner, cm.kind AS kind, cm.token || ':' || cm.ext || ':' || COALESCE(cm.still_ext, '') AS packed FROM json_each(?1) c CROSS JOIN (SELECT value AS kind FROM json_each(?2)) k CROSS JOIN remote_media cm INDEXED BY remote_media_owner ON cm.owner_id = c.value AND cm.kind = k.kind WHERE cm.token IS NOT NULL AND ((cm.kind = 'emoji' AND cm.domain IS NOT NULL AND cm.owner_id IS NULL) OR (cm.kind IN ('attachment', 'thumbnail') AND EXISTS (SELECT 1 FROM media_attachments em INDEXED BY sqlite_autoindex_media_attachments_1 WHERE em.id = cm.owner_id AND (em.file_token IS NULL AND em.account_id = cm.account_id AND CASE cm.kind WHEN 'attachment' THEN CAST(em.url AS BLOB) = CAST(cm.url AS BLOB) AND CASE em.type WHEN 'image' THEN 'image' WHEN 'gifv' THEN 'video' WHEN 'video' THEN 'video' WHEN 'audio' THEN 'audio' END = cm.category WHEN 'thumbnail' THEN CAST(em.preview_url AS BLOB) = CAST(cm.url AS BLOB) ELSE 0 END))) OR (cm.kind IN ('avatar', 'header') AND EXISTS (SELECT 1 FROM accounts eac INDEXED BY sqlite_autoindex_accounts_1 WHERE eac.id = cm.owner_id AND eac.id = cm.account_id AND eac.domain IS NOT NULL AND CAST(CASE cm.kind WHEN 'avatar' THEN eac.avatar_url ELSE eac.header_url END AS BLOB) = CAST(cm.url AS BLOB))))",
  "SELECT i.value AS value FROM instance_settings i WHERE i.name = ?",
  "SELECT l.account_id AS account_id, a.username AS username, l.suspended_at AS suspended_at FROM local_accounts l CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON a.id = l.account_id WHERE lower(l.email) = lower(?) LIMIT 2",
  "SELECT t.scopes, t.account_id, t.expires_at, c.id AS client_id, c.name, c.website, l.suspended_at, coalesce(t.epoch <> l.credential_epoch, 0) AS stale FROM oauth_tokens t CROSS JOIN oauth_clients c INDEXED BY sqlite_autoindex_oauth_clients_1 ON c.id = t.client_id LEFT JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON l.account_id = t.account_id WHERE t.token_hash = ? AND t.kind = 'access'",
];

const WITNESS = new PlanWitness(
  Object.fromEntries(Object.entries(MAIN).map(([id, sql]) => [id, { sql, pins: unpinned }])),
  LISTED,
  OTHER_STATEMENTS,
);

// A search's own range, grown by `n` accounts on `domain` named `prefix`… (display names likewise).
type Own = { domain: string; prefix: string };

// The admin (the OAuth admin, its token) and another local account; `n` remote accounts on each side of the search
// ranges' ids and names (usernames m… and z…, display names likewise, on domains d….example), one in five suspended
// and one in five whose deletion has started; the import-shaped accounts: usernames ab, AB, Ab and abc on several
// domains, an IDN domain stored as punycode and as raw text, a display name with NUL; and `own.n` accounts of a
// search's own range.
async function world(n: number, own: (Own & { n: number }) | null): Promise<StoreStub> {
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
    if (own !== null) {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain, display_name)
				SELECT CAST(560000000000000000 + i AS TEXT), 'https://' || ?2 || '/users/' || ?3 || '_' || i, ?3 || '_' || i,
					?2, ?3 || ' ' || i FROM n`,
        own.n,
        own.domain,
        own.prefix,
      );
    }
    side("700000000000000000", "z");
  });
  return store;
}

type Case = {
  filter: Partial<AdminAccountFilter>;
  page?: { minId?: string };
  // main's statements the list runs, in order, by identity.
  main: readonly string[];
  // The search's own range: how it grows, its population (SQL counting `n`), and the rewrite's rows read at most per
  // account it gains (at least one in all: the search reads them).
  own?: Own & { count: string; walks: number };
};

const NEIGHBOURS = "SELECT count(*) AS n FROM accounts WHERE username GLOB 'm[0-9]*' OR username GLOB 'z[0-9]*'";
const AB = "lower(username) >= 'ab' AND lower(username) < 'ac'";
const AB_DISPLAY = "lower(display_name) >= 'ab' AND lower(display_name) < 'ac'";
const SEARCHED = { domain: "d3.example", prefix: "ab" };

const CASES: Record<string, Case> = {
  "every account": { filter: {}, main: ["87b5a6e097e2f0cb", "da96c2c02866408c"] },
  "every account, ascending": {
    filter: {},
    page: { minId: "500000000000000000" },
    main: ["e2e93a1a778c9707", "da96c2c02866408c"],
  },
  "the active accounts": { filter: { status: "active" }, main: ["f3be293181dee3a2", "da96c2c02866408c"] },
  "the remote active accounts": {
    filter: { origin: "remote", status: "active" },
    main: ["d3a51ed21b532871", "da96c2c02866408c"],
  },
  "the suspended accounts": {
    filter: { status: "suspended" },
    main: ["84a709feed240a8b", "5e93376476b36f62", "aee0f20d53a2d8e7", "da96c2c02866408c"],
  },
  "the remote accounts": { filter: { origin: "remote" }, main: ["70b8e6d1f272c79d", "da96c2c02866408c"] },
  "the remote accounts, ascending": {
    filter: { origin: "remote" },
    page: { minId: "500000000000000000" },
    main: ["bd9046d277ce1943", "da96c2c02866408c"],
  },
  "the local accounts": { filter: { origin: "local" }, main: ["9e86529db4696242", "da96c2c02866408c"] },
  "an email prefix": { filter: { email: "ADMIN" }, main: ["9e86529db4696242", "82fc0e40127c6e76", "da96c2c02866408c"] },
  "a username prefix, folded": {
    filter: { username: "aB" },
    main: ["06ec3b06baf5d9a5", "b0133054d2369745", "da96c2c02866408c"],
    own: { ...SEARCHED, count: `SELECT count(*) AS n FROM accounts WHERE ${AB}`, walks: 3 },
  },
  "a username prefix on a domain": {
    filter: { username: "ab", byDomain: "d3.example" },
    main: ["92542d5a04dd9c95", "78569b4e54647cc3", "da96c2c02866408c"],
    own: { ...SEARCHED, count: `SELECT count(*) AS n FROM accounts WHERE domain = 'd3.example' AND ${AB}`, walks: 3 },
  },
  "an IDN domain as stored": {
    filter: { byDomain: "xn--bcher-kva.example" },
    main: ["564c8028d796e438", "86e3b5718de79c79", "da96c2c02866408c"],
    own: {
      domain: "xn--bcher-kva.example",
      prefix: "idn",
      count: "SELECT count(*) AS n FROM accounts WHERE domain = 'xn--bcher-kva.example'",
      walks: 3,
    },
  },
  "a display name prefix": {
    filter: { displayName: "AB" },
    main: ["c692feac604bb9d0", "7511bb5f1914c901", "da96c2c02866408c"],
    own: { ...SEARCHED, count: `SELECT count(*) AS n FROM accounts WHERE ${AB_DISPLAY}`, walks: 3 },
  },
  "a username and a display name": {
    filter: { username: "ab", displayName: "ab" },
    main: ["06ec3b06baf5d9a5", "f6668832891ebeb7", "da96c2c02866408c"],
    own: { ...SEARCHED, count: `SELECT count(*) AS n FROM accounts WHERE ${AB} AND ${AB_DISPLAY}`, walks: 4 },
  },
};

async function sides(statistics: Statistics, c: Case, n: number, own: number): Promise<Run> {
  const store = await world(n, c.own === undefined ? null : { ...c.own, n: own });
  return runInDurableObject(store, (_instance, state) =>
    WITNESS.measure(state, {
      statistics,
      expected: c.main,
      populations: { neighbours: NEIGHBOURS, ...(c.own === undefined ? {} : { range: c.own.count }) },
      run: (sql, transact) =>
        listAdminAccounts.run(
          sql,
          {
            credential: { tokenHash: ADMIN_TOKEN, scope: "admin:read:accounts", now: NOW },
            filter: { ...NONE, ...c.filter },
            page: { limit: 20, ...c.page },
            present: PRESENT,
          },
          transact,
        ),
    }),
  );
}

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    await WITNESS.expectAudited();
  });
});

describe("admin account reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const c = CASES[name]!;
      // The neighbours grow (the search's own range at 100 accounts, or none).
      const few = await sides(statistics, c, FEW, 100);
      const many = await sides(statistics, c, MANY, 100);
      const runs = [few, many];
      // The search's own range grows (the neighbours held).
      const ownMany = c.own === undefined ? undefined : await sides(statistics, c, FEW, 200);
      if (ownMany !== undefined) {
        runs.push(ownMany);
      }
      for (const run of runs) {
        expect((run.result as { status: string }).status).toBe("ok");
        expectBeside(statistics, run);
      }
      // The neighbours: the same rows.
      expectGrowth(few, many, { populations: ["neighbours"], perSide: {} });
      if (c.own !== undefined && ownMany !== undefined) {
        // The own range: it grew by 100, and the reads grew by at least one and at most `walks` rows per account it
        // gained.
        expect(ownMany.populations.range! - few.populations.range!).toBe(100);
        expectGrowth(few, ownMany, {
          populations: ["range"],
          perSide: { "*": { population: "range", perRun: c.own.walks } },
          total: { atLeast: "gain" },
        });
      }
    },
    120_000,
  );
});
