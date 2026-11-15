-- Kopje Store schema 0096: one remote account per address. Never edit after release (checksummed).
--
-- A remote account's handle (username and domain) is taken only once WebFinger confirms it for the actor, and one
-- remote account holds an address (src/domain/remote-actors.ts acceptedHandle): accounts_domain_username becomes UNIQUE
-- on (domain, lower(username)), the check on every writer (the Store's stores of actor documents, an import, the
-- cutover conversion). Local rows (domain NULL) are not constrained by it (SQLite's NULLs are distinct);
-- accounts_local_username keeps theirs. Mastodon has the same unique index
-- (index_accounts_on_username_and_domain_lower).
-- A remote account whose handle another account holds is invalidated: its username becomes '! ' and its own id
-- (Mastodon's invalidate_username!), which no valid username can be, and it is presented as `<id>@handle.invalid`
-- (src/domain/accounts.ts shownHandle) until a refresh confirms a handle for it.
--
--   accounts (reserved form)   every remote username already in the reserved form ('! ' and anything) is set to '! '
--                              and its own row's id first. No Kopje writer produced one, but usernames are
--                              unconstrained and an imported nonconforming one is kept, so a row stored as '! <id3>'
--                              and row id3's invalidation below would otherwise share an address. Afterwards every
--                              reserved-form username names its own row, and ids are unique.
--   accounts (shared address)  every remote row that shares (domain, lower(username)) with a row of lower rowid is
--                              invalidated. The lowest rowid keeps the handle: it is the row an address named before
--                              (addressRow), so no address changes the account it names. Nothing is deleted: follows,
--                              statuses, keys and relationships stay on their rows, and the old handle stays in raw.
--                              In both, search_text is rewritten as accountSearchText (src/domain/search-text.ts)
--                              writes it for the new username when it ends with the old address part (lowercased,
--                              after a space or alone), else left as it is (an imported value; the refresh rewrites
--                              it).
--   accounts_domain_username   recreated UNIQUE under the same name, so every INDEXED BY keeps working.
--   accounts_local_username    recreated after it, unchanged, so the planner meets the two in the order it met them
--                              before: with ANALYZE statistics, the local timeline (timelines.ts publicTimeline)
--                              enters from the local accounts only in that order, and walks every public status in the
--                              other (test/timeline-plans.test.ts).
--   accounts.handle_refreshed_at  when an invalidation last asked for the account's refresh (the Store's clock, ms),
--                              written only by the invalidation's UPDATE, which asks again only a day
--                              (ACCOUNT_STALE_MS) later, so automatic refreshes of accounts that take a handle from
--                              each other stop. NULL here: the requests below are one-off, not a chain.
--   collection_syncs.refresh   1 when the sync first refetches the account's document and confirms its handle (the
--                              document part, src/federation/collections.ts); a refresh request for every reserved-form
--                              remote row, due at once (HANDLE_REFRESH_REQUESTS in src/domain/handle-refreshes.ts,
--                              which the cutover conversion runs too).
--
-- accounts.confirmed_username is no longer read or written: the stored handle is the confirmed one. The column stays,
-- since dropping it would rewrite every account row.
--
-- Cost: the reserved-form pass reads each remote row once with no join; the shared-address pass reads each remote row
-- and seeks accounts_domain_username once for it (rowid < its own); each of the two indexes is rebuilt once, the local
-- one reading every row for its few entries. The new accounts column
-- has no default and no CHECK, so SQLite neither rewrites nor reads the accounts; the collection_syncs column's CHECK
-- reads the pending syncs. As the file recreates an index UNIQUE, it cannot declare foreignKeys: 'unchanged'
-- (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

UPDATE accounts SET username = '! ' || id,
  search_text = CASE
    WHEN search_text = lower(username || '@' || domain) THEN '! ' || id || '@' || lower(domain)
    WHEN substr(search_text, -length(username || '@' || domain) - 1) = ' ' || lower(username || '@' || domain)
      THEN substr(search_text, 1, length(search_text) - length(username || '@' || domain)) || '! ' || id || '@' || lower(domain)
    ELSE search_text END
WHERE domain IS NOT NULL AND substr(username, 1, 2) = '! ' AND username <> '! ' || id;

UPDATE accounts SET username = '! ' || id,
  search_text = CASE
    WHEN search_text = lower(username || '@' || domain) THEN '! ' || id || '@' || lower(domain)
    WHEN substr(search_text, -length(username || '@' || domain) - 1) = ' ' || lower(username || '@' || domain)
      THEN substr(search_text, 1, length(search_text) - length(username || '@' || domain)) || '! ' || id || '@' || lower(domain)
    ELSE search_text END
WHERE domain IS NOT NULL AND EXISTS (SELECT 1 FROM accounts k INDEXED BY accounts_domain_username
  WHERE k.domain = accounts.domain AND lower(k.username) = lower(accounts.username) AND k.rowid < accounts.rowid);

DROP INDEX accounts_domain_username;

CREATE UNIQUE INDEX accounts_domain_username ON accounts (domain, lower(username));

DROP INDEX accounts_local_username;

CREATE UNIQUE INDEX accounts_local_username ON accounts (lower(username)) WHERE domain IS NULL;

ALTER TABLE accounts ADD COLUMN handle_refreshed_at INTEGER;

ALTER TABLE collection_syncs ADD COLUMN refresh INTEGER NOT NULL DEFAULT 0 CHECK (refresh IN (0, 1));

INSERT INTO collection_syncs (account_id, due_at, refresh)
SELECT id, 0, 1 FROM accounts WHERE domain IS NOT NULL AND substr(username, 1, 2) = '! '
ON CONFLICT (account_id) DO UPDATE SET refresh = 1;
