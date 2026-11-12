// The pending apps of RES-6 (domain/oauth.ts): the clients no user has authorized, the web UI's own client aside. One
// predicate for the registration budget (registerApp) and the import's refusal of a dump past it (store-import.ts), so
// the two count the same apps.

// At most this many pending apps are kept (domain/oauth.ts, registerApp; an import past it is refused).
export const MAX_PENDING_APPS = 500;

// instance_settings name of the web UI's own OAuth client (domain/web-session.ts).
export const WEB_CLIENT_SETTING = "web_client_id";

// Clients no user has authorized, by the partial index in (created_at, id) order; `extra` narrows them further.
export function pendingAppsSql(extra = ""): string {
  return `FROM oauth_clients c INDEXED BY oauth_clients_pending
		WHERE c.authorized = 0
			AND c.id IS NOT (SELECT value FROM instance_settings WHERE name = '${WEB_CLIENT_SETTING}')
			${extra}`;
}
