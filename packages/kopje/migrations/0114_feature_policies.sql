-- Kopje Store schema 0114: remote accounts' feature policies, the FEP-7aa9 canFeature of their actor documents
-- (#1589's D23). Never edit after release (checksummed).
--
--   accounts.feature_policy        Mastodon's Account#feature_approval_policy: InteractionPolicy's bitmap of the
--                                  actor's interactionPolicy.canFeature, its automatic half in the high 16 bits, as
--                                  Mastodon's ActivityPub::Parser::InteractionPolicyParser reads it; written by every
--                                  store of a remote actor's document (src/domain/remote-actors.ts storeActor) and
--                                  read by R45's consent rule (src/domain/audience.ts featureApprovalSql). An integer
--                                  from 0 to 2^32 - 1; 0 (a policy that names no one: Mastodon's `missing`) for every
--                                  local account and for every row the upgrade carries, until its document is stored
--                                  again.
--   accounts_feature_policy_insert BEFORE INSERT and BEFORE UPDATE OF feature_policy, domain on accounts:
--   accounts_feature_policy_update RAISE(ABORT, 'accounts: feature_policy past its stored bound') for a value that is
--                                  not an integer, outside 0 to 2^32 - 1, or not 0 on a local account.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (featurePolicyPastBoundSql); the statements below are its
-- registered triggers (src/domain/stored-triggers.ts, which test/migrations.test.ts holds them to); stored form:
-- docs/dump-format.md.
--
-- Cost: the column has a constant default and no CHECK, so adding it reads and rewrites no row; no index is made (the
-- column is read only with its row); the triggers read no row and name no other table.

ALTER TABLE accounts ADD COLUMN feature_policy INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER accounts_feature_policy_insert BEFORE INSERT ON accounts
WHEN CASE WHEN typeof(NEW.feature_policy) <> 'integer' THEN 1
	WHEN NEW.feature_policy NOT BETWEEN 0 AND 4294967295 THEN 1
	WHEN NEW.feature_policy <> 0 AND NEW.domain IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: feature_policy past its stored bound');
END;

CREATE TRIGGER accounts_feature_policy_update BEFORE UPDATE OF feature_policy, domain ON accounts
WHEN CASE WHEN typeof(NEW.feature_policy) <> 'integer' THEN 1
	WHEN NEW.feature_policy NOT BETWEEN 0 AND 4294967295 THEN 1
	WHEN NEW.feature_policy <> 0 AND NEW.domain IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: feature_policy past its stored bound');
END;
