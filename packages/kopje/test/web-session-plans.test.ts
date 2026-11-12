import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { settingsView } from "../src/domain/web-session";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type PlannedStatement, plannedSql, scansOf } from "./read-helpers";

// RES-7 witness of the settings page's authorizations (web-session.ts authorizationsOf), under the plan audit's
// singleton statistics and after ANALYZE:
//   - the apps the viewer authorized, through oauth_tokens_account, each app by its key, read the same rows as other
//     accounts' tokens and apps grow (on both sides of the viewer's account and app ids), and grow by at most three
//     rows per token of the viewer's own (its index entry, the token, its app or credential epoch by key): the page
//     lists every app the viewer authorized;
//   - the count of the viewer's other web sessions walks the web client's tokens through oauth_tokens_client, every
//     account's web sessions (a row each), a gap of #1481: no index holds an account's tokens by client, and the
//     viewer's own tokens through oauth_tokens_account can be the larger walk. Web sessions are those of the local
//     accounts, operator-sized (docs/threat-model.md, "Deployment assumptions"), but any number each.

const VIEWER = "600000000000000002";
const BELOW = "600000000000000001";
const ABOVE = "600000000000000003";
const WEB = "web";
const STATISTICS = ["singleton", "analyzed"] as const;

// The viewer's web session and `own` tokens of its own (one app each, its apps named v…), and `n` tokens of each of
// the accounts below and above it, of apps named a… and z….
async function world(n: number, own: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT INTO instance_settings (name, value) VALUES ('web_client_id', ?)", WEB);
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES (?, 's', 'web', 'urn:ietf:wg:oauth:2.0:oob', 'read write')",
      WEB,
    );
    for (const [id, name] of [
      [BELOW, "below"],
      [VIEWER, "viewer"],
      [ABOVE, "above"],
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
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', ?, ?, 'read write')",
      WEB,
      VIEWER,
    );
    const tokens = (account: string, prefix: string, count: number) => {
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes)
				SELECT ?2 || i, 's', ?2 || i, 'urn:ietf:wg:oauth:2.0:oob', 'read' FROM n WHERE ?1 > 0`,
        count,
        prefix,
      );
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
				SELECT ?2 || 'token' || i, 'access', ?2 || i, ?3, 'read' FROM n WHERE ?1 > 0`,
        count,
        prefix,
        account,
      );
      // Web sessions too, as many.
      sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
				SELECT ?2 || 'web' || i, 'access', ?3, ?4, 'read write' FROM n WHERE ?1 > 0`,
        count,
        prefix,
        WEB,
        account,
      );
    };
    tokens(BELOW, "a", n);
    tokens(ABOVE, "z", n);
    tokens(VIEWER, "v", own);
  });
  return store;
}

async function planned(statistics: (typeof STATISTICS)[number], n: number, own: number) {
  const store = await world(n, own);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const plans: PlannedStatement[] = [];
    const answer = settingsView.run(
      plannedSql(sql, /FROM oauth_tokens t (?:JOIN|WHERE)/, plans),
      {
        credential: { tokenHash: "viewer", scope: "read", now: NOW },
        now: NOW,
        present: { origin: "https://kopje.test" },
      },
      (fn) => fn(),
    );
    // The populations: others' tokens of apps, others' web sessions, the viewer's own tokens.
    const count = (where: string) =>
      sql.exec<{ n: number }>(`SELECT count(*) AS n FROM oauth_tokens WHERE ${where}`, VIEWER, WEB).one().n;
    const others = {
      apps: count("account_id <> ?1 AND client_id <> ?2"),
      web: count("account_id <> ?1 AND client_id = ?2"),
    };
    const own = count("account_id = ?1 AND (client_id <> ?2 OR token_hash <> 'viewer')");
    return { plans, answer, others, own };
  });
}

describe("the settings page's authorizations (RES-7)", () => {
  it.each(STATISTICS)(
    "%s statistics: the apps read the same rows as others' tokens grow, and at most three per token of the viewer's own",
    async (statistics) => {
      const few = await planned(statistics, 200, 0);
      const many = await planned(statistics, 400, 0);
      const ownFew = await planned(statistics, 20, 100);
      const ownMany = await planned(statistics, 20, 200);
      // Others' app tokens and web sessions grow by 400 each; the viewer's own tokens by 200.
      expect(many.others.apps - few.others.apps).toBe(400);
      expect(many.others.web - few.others.web).toBe(400);
      expect(ownMany.own - ownFew.own).toBe(200);
      expect(few.answer).toMatchObject({ status: "ok", value: { authorizations: { apps: [], otherSessions: 0 } } });
      expect(ownMany.answer).toMatchObject({ status: "ok", value: { authorizations: { otherSessions: 200 } } });
      expect(few.plans).toHaveLength(2);
      for (const { plan } of [...many.plans, ...ownMany.plans]) {
        expect(scansOf(plan, ["t", "c"])).toEqual([]);
      }
      const [apps, sessions] = [0, 1];
      // The apps: the same rows as others' tokens grow, at most three more per token of the viewer's own (200 more).
      expect(many.plans[apps]!.rows).toBe(few.plans[apps]!.rows);
      const ownGrowth = ownMany.plans[apps]!.rows - ownFew.plans[apps]!.rows;
      expect(ownGrowth).toBeGreaterThanOrEqual(ownMany.own - ownFew.own);
      expect(ownGrowth).toBeLessThanOrEqual(3 * (ownMany.own - ownFew.own));
      // The other sessions: a row per web session of any account, the gap.
      expect(many.plans[sessions]!.rows - few.plans[sessions]!.rows).toBe(many.others.web - few.others.web);
      expect(ownMany.plans[sessions]!.rows - ownFew.plans[sessions]!.rows).toBeLessThanOrEqual(
        2 * (ownMany.own - ownFew.own),
      );
    },
    120_000,
  );
});
