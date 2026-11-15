// The refresh requests of the invalidated remote accounts (collection_syncs.refresh, the sync's document part in
// remote-collections.ts). No imports: the cutover's converter runs this module from the sources on Node
// (cli/lib/cutover/kopje-runtime.js).

// A refresh request for every invalidated remote account (its username in the reserved form, accounts.ts
// shownHandle), due at once; a sync already waiting only gains the refresh. Run by migration 0096_remote_handles
// (test/migrations.test.ts checks its text) and by the cutover conversion after it writes the accounts
// (requestHandleRefreshes), since cutover creates the Store before it converts anything. Neither writes
// accounts.handle_refreshed_at: these requests are one-off, not a chain of invalidations (remote-actors.ts).
export const HANDLE_REFRESH_REQUESTS = `INSERT INTO collection_syncs (account_id, due_at, refresh)
SELECT id, 0, 1 FROM accounts WHERE domain IS NOT NULL AND substr(username, 1, 2) = '! '
ON CONFLICT (account_id) DO UPDATE SET refresh = 1;`;

export function requestHandleRefreshes(db: { exec(sql: string): unknown }): void {
  db.exec(HANDLE_REFRESH_REQUESTS);
}
