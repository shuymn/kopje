// The accounts of the plan witnesses that grow one viewer's key between two others (test/search-plans.test.ts,
// test/tag-suggestions-plans.test.ts): three local accounts, LOW and HIGH on either side of VIEWER's id, and VIEWER's
// access token "viewer" (scopes read and write).

export const VIEWER = "600000000000000001";
export const LOW = "500000000000000001";
export const HIGH = "700000000000000001";

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

export function seedViewerBetween(sql: SqlStorage): void {
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
}
