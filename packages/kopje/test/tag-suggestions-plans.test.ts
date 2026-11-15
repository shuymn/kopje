import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { featuredTagSuggestions, suggestionsSince } from "../src/domain/tags";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";

// RES-7 witness of featured tag suggestions beside main's statement (test/plan-witness.ts), under the plan audit's
// singleton statistics and after ANALYZE, taken once every population exists. The rewrite keeps main's shape and adds
// what Mastodon 4.7.5 asks (the window's id bound, the kept originals, HAVING), so main's statement runs with the
// three parameters it takes. Each population grows apart, counted by its own predicate: the viewer's statuses older
// than a year (which main's window reads and the rewrite's leaves out), the viewer's statuses of the year past the
// 1,000 of the window (its own key), and the statuses of the accounts on either side of the viewer's key. Old
// statuses carry no hashtag, so both read the same hashtags: the rewrite returns main's rows, reads no more than main
// with either statistics, and reads no more as any population grows. Import-shaped rows: two spellings of one name on
// one status, a name with a NUL inside, and counts tied across names. Every other statement the operation makes is
// allowed literally; any further statement fails the witness.

const VIEWER = "600000000000000001";
const LOW = "500000000000000001";
const HIGH = "700000000000000001";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SINCE = suggestionsSince(NOW);

const MAIN_ID = "07b014821d7a5016";
const WITNESS = new PlanWitness(
  {
    [MAIN_ID]: {
      sql: "SELECT hex(CASE WHEN length(CAST(t.name AS BLOB)) <= 1024 AND length(t.name) <= 256 THEN t.name END) AS key FROM (SELECT id FROM statuses WHERE account_id = ?1 ORDER BY id DESC LIMIT ?2) r CROSS JOIN status_tags t ON t.status_id = r.id WHERE CASE WHEN length(CAST(t.name AS BLOB)) <= 1024 AND length(t.name) <= 256 THEN t.name END IS NOT NULL AND NOT EXISTS (SELECT 1 FROM featured_tags f WHERE f.account_id = ?1 AND f.name = t.name) GROUP BY t.name ORDER BY count(*) DESC, t.name LIMIT ?3",
      text: "SELECT hex(CASE WHEN length(CAST(t.name AS BLOB)) <= 1024 AND length(t.name) <= 256 THEN t.name END) AS key FROM ( SELECT id, withdrawn, reblog_of_id FROM statuses INDEXED BY statuses_account WHERE account_id = ?1 AND id >= ?4 ORDER BY id DESC LIMIT ?2) r CROSS JOIN status_tags t ON t.status_id = r.id WHERE r.withdrawn = 0 AND r.reblog_of_id IS NULL AND CASE WHEN length(CAST(t.name AS BLOB)) <= 1024 AND length(t.name) <= 256 THEN t.name END IS NOT NULL AND NOT EXISTS (SELECT 1 FROM featured_tags f WHERE f.account_id = ?1 AND f.name = t.name) GROUP BY t.name HAVING count(*) > 1 ORDER BY count(*) DESC, t.name LIMIT ?3",
      params: (mine) => mine.slice(0, 3),
    },
  },
  /GROUP BY t\.name/,
  [
    "SELECT t.scopes, t.account_id, t.expires_at, c.id AS client_id, c.name, c.website, l.suspended_at, coalesce(t.epoch <> l.credential_epoch, 0) AS stale FROM oauth_tokens t CROSS JOIN oauth_clients c INDEXED BY sqlite_autoindex_oauth_clients_1 ON c.id = t.client_id LEFT JOIN local_accounts l INDEXED BY sqlite_autoindex_local_accounts_1 ON l.account_id = t.account_id WHERE t.token_hash = ? AND t.kind = 'access'",
    "SELECT hex(name) AS key FROM tag_follows WHERE account_id = ?1 AND name IN (SELECT CAST(unhex(value) AS TEXT) FROM json_each(?2))",
    "SELECT hex(name) AS key FROM featured_tags WHERE account_id = ?1 AND name IN (SELECT CAST(unhex(value) AS TEXT) FROM json_each(?2))",
    "SELECT substr(coalesce(CASE WHEN octet_length(s.published_at) > 64 THEN NULL WHEN length(CAST(s.published_at AS BLOB)) = 24 AND substr(s.published_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at) = s.published_at THEN s.published_at WHEN instr(CAST(s.published_at AS BLOB), x'00') = 0 AND s.published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds'), 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '+0 seconds') END) END, CASE WHEN octet_length(s.created_at) > 64 THEN NULL WHEN length(CAST(s.created_at AS BLOB)) = 24 AND substr(s.created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at) = s.created_at THEN s.created_at WHEN instr(CAST(s.created_at AS BLOB), x'00') = 0 AND s.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN (CASE WHEN length(CAST(strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') AS BLOB)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds'), 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds')) = strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at, '+0 seconds') END) END, '1970-01-01T00:00:00.000Z'), 1, 10) AS day, count(*) AS uses, count(DISTINCT s.account_id) AS accounts FROM (SELECT t.status_id FROM status_tags t INDEXED BY status_tags_public WHERE t.name = CAST(unhex(?1) AS TEXT) AND t.public = 1 AND t.status_id >= ?2 ORDER BY t.status_id DESC LIMIT ?3) c CROSS JOIN statuses s INDEXED BY sqlite_autoindex_statuses_1 ON s.id = c.status_id WHERE s.visibility = 'public' AND s.reblog_of_id IS NULL AND ((NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = s.account_id AND pl.suspended_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts pa INDEXED BY accounts_deleted WHERE pa.id = s.account_id AND pa.deleted_at IS NOT NULL UNION ALL SELECT 1 FROM main.accounts ps INDEXED BY accounts_suspended WHERE ps.id = s.account_id AND (ps.suspended_at IS NOT NULL AND ps.suspension_source = 'account')) AND NOT (CASE WHEN EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend WHERE severity = 'suspend') THEN EXISTS (WITH RECURSIVE pk(d) AS (SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(pc.domain, '.') ELSE rtrim(lower(substr(substr(substr(pc.uri, instr(pc.uri, '://') + 3), 1, instr(substr(pc.uri, instr(pc.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(pc.uri, instr(pc.uri, '://') + 3), 1, instr(substr(pc.uri, instr(pc.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.') END FROM main.accounts pc INDEXED BY sqlite_autoindex_accounts_1 CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE pc.domain IS NOT NULL AND pc.id = s.account_id), ps(d, dots) AS (SELECT CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN d END, CASE WHEN length(CAST(d AS BLOB)) <= 1012 THEN length(d) - length(replace(d, '.', '')) ELSE -1 END FROM pk UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1 AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY sqlite_autoindex_instance_domain_blocks_1 WHERE ps.dots BETWEEN 1 AND 7 AND pn.domain = ps.d)) SELECT 1 FROM ps LEFT JOIN main.instance_domain_blocks pr INDEXED BY sqlite_autoindex_instance_domain_blocks_1 ON ps.dots BETWEEN 1 AND 7 AND pr.domain = ps.d WHERE ps.dots < 0 OR (pr.domain IS NOT NULL AND pr.severity = 'suspend')) ELSE 0 END)) AND s.withdrawn = 0 AND (s.account_id IS NULL OR (NOT EXISTS (SELECT 1 FROM main.blocks pb WHERE pb.account_id = s.account_id AND pb.target_account_id = NULL) AND (CASE WHEN s.visibility IN ('public', 'unlisted') THEN CASE WHEN EXISTS (SELECT 1 FROM main.accounts pv INDEXED BY sqlite_autoindex_accounts_1 WHERE pv.id = NULL AND pv.domain IS NOT NULL) THEN NOT EXISTS (SELECT 1 FROM main.accounts pda INDEXED BY sqlite_autoindex_accounts_1 CROSS JOIN main.domain_blocks pdb ON pdb.account_id = s.account_id AND (pda.domain IS NOT NULL AND pdb.domain IN (rtrim(pda.domain, '.'), rtrim(lower(substr(substr(substr(pda.uri, instr(pda.uri, '://') + 3), 1, instr(substr(pda.uri, instr(pda.uri, '://') + 3) || '/', '/') - 1), 1, instr(substr(substr(pda.uri, instr(pda.uri, '://') + 3), 1, instr(substr(pda.uri, instr(pda.uri, '://') + 3) || '/', '/') - 1) || ':', ':') - 1)), '.'))) WHERE pda.id = NULL) ELSE 1 END ELSE (s.visibility = 'private' AND EXISTS (SELECT 1 FROM main.follows fo WHERE fo.account_id IS NULL AND fo.target_account_id = s.account_id AND fo.state = 'accepted')) OR EXISTS (SELECT 1 FROM main.status_mentions sm WHERE sm.status_id = s.id AND sm.account_id IS NULL) END)))) GROUP BY day",
  ],
);

type Shape = { recent: number; old: number; others: number };
const BASE: Shape = { recent: 60, old: 40, others: 40 };

// An id of `ms`, its low bits telling the accounts apart.
const idAt = (ms: number, low: number) => ((BigInt(ms) << 16n) + BigInt(low)).toString();

function local(sql: SqlStorage, id: string, name: string) {
  sql.exec(
    "INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)",
    id,
    `https://kopje.test/ap/users/${name}`,
    name,
  );
  sql.exec(
    "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
    id,
    `${name}@example.com`,
  );
}

// `count` statuses of `account`, a minute apart back from `from`, the i-th newest carrying `names(i)`.
function statuses(sql: SqlStorage, account: string, count: number, from: number, names: (i: number) => string[]) {
  for (let i = 0; i < count; i++) {
    const id = idAt(from - i * MINUTE, Number(account.slice(0, 1)));
    sql.exec(
      "INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)",
      id,
      `https://kopje.test/ap/o/${id}`,
      account,
      new Date(from - i * MINUTE).toISOString(),
    );
    for (const name of names(i)) {
      sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)", id, name);
    }
  }
}

// Each name on several statuses, counts tied across names; the newest four hold the import-shaped names.
const tagsOf = (i: number) => [`a${i % 7}`, `b${i % 11}`, ...(i < 2 ? ["Dup", "dup"] : i < 4 ? ["nul\u0000x"] : [])];

function shaped(sql: SqlStorage, shape: Shape) {
  local(sql, LOW, "low");
  local(sql, VIEWER, "viewer");
  local(sql, HIGH, "high");
  sql.exec(
    "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write')",
  );
  sql.exec(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write')",
    VIEWER,
  );
  statuses(sql, LOW, shape.others, NOW - DAY, tagsOf);
  statuses(sql, VIEWER, shape.recent, NOW - DAY, tagsOf);
  statuses(sql, VIEWER, shape.old, NOW - 400 * DAY, () => []);
  statuses(sql, HIGH, shape.others, NOW - DAY, tagsOf);
}

const POPULATIONS = {
  old: `SELECT count(*) AS n FROM statuses WHERE account_id = '${VIEWER}' AND id < '${SINCE}'`,
  recent: `SELECT count(*) AS n FROM statuses WHERE account_id = '${VIEWER}' AND id >= '${SINCE}'`,
  others: `SELECT count(*) AS n FROM statuses WHERE account_id IN ('${LOW}', '${HIGH}')`,
};

async function measured(statistics: Statistics, shape: Shape): Promise<Run> {
  const store = await migratedStore();
  return runInDurableObject(store, (_instance, state) => {
    shaped(state.storage.sql, shape);
    return WITNESS.measure(state, {
      statistics,
      expected: [MAIN_ID],
      populations: POPULATIONS,
      run: (sql, transact) =>
        featuredTagSuggestions.run(
          sql,
          { credential: { tokenHash: "viewer", scope: "read", now: NOW }, present: { origin: "https://kopje.test" } },
          transact,
        ),
    });
  });
}

const GROWTHS: Record<string, { shape: Shape; population: keyof typeof POPULATIONS }> = {
  "the viewer's statuses older than a year": { shape: { ...BASE, old: 600 }, population: "old" },
  "the viewer's statuses of the year past the window": { shape: { ...BASE, recent: 1300 }, population: "recent" },
  "the statuses of the accounts on either side": { shape: { ...BASE, others: 400 }, population: "others" },
};

describe("featured tag suggestions beside main's (RES-7)", () => {
  it("is main's audited statement", async () => {
    await WITNESS.expectAudited();
  });

  it.each(STATISTICS.flatMap((statistics) => Object.keys(GROWTHS).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const growth = GROWTHS[name]!;
      const from = growth.population === "recent" ? { ...BASE, recent: 1000 } : BASE;
      const base = await measured(statistics, from);
      const more = await measured(statistics, growth.shape);
      for (const run of [base, more]) {
        expectBeside(statistics, run, { singletonRows: true });
        const value = (run.result as { status: string; value: { name: string }[] }).value;
        expect(value.map((tag) => tag.name)).toHaveLength(10);
      }
      expectGrowth(base, more, {
        populations: [growth.population],
        perSide: { "*": { population: growth.population, perRun: 0 } },
      });
      // main's window reads the old statuses the bound leaves out.
      if (growth.population === "old") {
        expect(more.sides[0]!.main.rows).toBeGreaterThan(base.sides[0]!.main.rows);
      }
    },
    300_000,
  );
});
